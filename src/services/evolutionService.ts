import { GoogleGenAI, Type } from "@google/genai";
import {
  Chapter,
  Definition,
  EngineOptions,
  GEMINI_MODELS,
  SearchFallbackMode,
  SearchFallbackPayload,
  SearchFallbackReason,
  SubTopic,
  WebBook,
  WebBookSourceMode,
  WebPageGenotype,
} from "../types";
import { fetchGoogleSearchFallback } from "./googleSearchFallbackClient";
import { buildGeminiUserFacingErrorMessage, GeminiFailureReason } from "./geminiUserFacingErrors";
import { isNonJsonResponseText } from "./safeResponse";
import { SYNTHETIC_FALLBACK_DIAGNOSTIC, describeFallbackEvidence, isSyntheticFallbackPayload } from "./searchFallbackShared";

export function buildSyntheticFallbackPayload(query: string, mode: SearchFallbackMode = 'google_duckduckgo'): SearchFallbackPayload {
  const provider = mode === 'duckduckgo' ? 'duckduckgo' : 'google';
  return {
    query,
    provider,
    summary: `Structured overview for ${query}.`,
    aiOverview: [],
    results: [
      {
        title: `${query} Overview`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(query.replace(/\s+/g, '_'))}`,
        snippet: `Comprehensive overview, historical background, and fundamental principles of ${query}.`,
        domain: 'wikipedia.org',
      },
    ],
    extractedAt: Date.now(),
    diagnostics: [SYNTHETIC_FALLBACK_DIAGNOSTIC],
  };
}

export const ASSEMBLY_SOURCE_POOL_SIZE = 4;

const CANDIDATE_MODELS = [
  ...GEMINI_MODELS,
];

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

const getAI = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1500): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (
      retries > 0 &&
      (error.message?.includes("429") ||
        error.message?.includes("quota") ||
        error.message?.includes("RESOURCE_EXHAUSTED"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function repairTruncatedJSON(jsonString: string): string {
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.length > 0) {
        const last = stack[stack.length - 1];
        if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
          stack.pop();
        }
      }
    }
  }

  let repaired = jsonString;
  if (inString) {
    repaired += '"';
  }

  while (stack.length > 0) {
    const last = stack.pop();
    if (last === '{') repaired += '}';
    else if (last === '[') repaired += ']';
  }

  return repaired;
}

function detectGeminiFailureReason(err: any): GeminiFailureReason {
  const message = String(err?.message || err?.statusText || err || '').toLowerCase();
  const status = Number(err?.status || err?.code);

  if (status === 401 || message.includes('api_key_invalid') || message.includes('unauthenticated') || message.includes('invalid api key')) {
    return 'invalid_api_key';
  }
  if (!process.env.GEMINI_API_KEY || message.includes('missing api key')) {
    return 'missing_api_key';
  }
  if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('resource_exhausted')) {
    return 'quota_or_rate_limit';
  }
  if (status === 503 || message.includes('503') || message.includes('unavailable')) {
    return 'service_unavailable';
  }
  // An HTML page where JSON was expected (proxy/gateway/auth page) means the service is
  // reachable but not answering properly, which is not a connectivity problem on the user's side.
  if (isNonJsonResponseText(String(err?.message || err?.statusText || err || ''))) {
    return 'service_unavailable';
  }
  return 'network_unreachable';
}

// Calls Gemini with exactly the model the user selected. It never silently substitutes another model,
// so the notice and the actual behaviour always agree; an unavailable model surfaces as an error instead.
async function generateWithModelFallback(
  ai: GoogleGenAI,
  requestParams: any,
  preferredModel?: string
): Promise<any> {
  const model = preferredModel || DEFAULT_GEMINI_MODEL;
  return withRetry(() =>
    ai.models.generateContent({
      ...requestParams,
      model,
    })
  );
}

export function isMeaningful(text: string, description?: string): boolean {
  if (!text) return false;
  const clean = text.replace(/\s/g, '');
  const lowerText = text.toLowerCase();
  const lowerDesc = (description || '').toLowerCase();

  // Filter out pure digits
  if (/^\d+$/.test(clean)) return false;
  // Filter out long sequences of identical characters
  if (/(.)\1{8,}/.test(clean)) return false;
  // Filter out strings with more than 10 consecutive digits
  if (/\d{10,}/.test(clean)) return false;
  // Filter out very long strings without spaces (likely code, tokens or IDs)
  if (text.length > 40 && !text.includes(' ')) return false;
  // Filter out strings that look like random hex/alphanumeric (no vowels and long)
  if (clean.length > 12 && !/[aeiou]/i.test(clean)) return false;

  // Anti-poisoning & copyright boilerplate filters
  const poisonKeywords = [
    'copyright', 'rights reserved', 'terms of service', 'privacy policy',
    'unauthorized access', 'cybersecurity', 'protected by', 'cookie policy',
    'scrapping', 'bot detection', 'access denied', 'legal notice', 'disclaimer',
    'all rights', 'terms of use', 'security warning', 'intellectual property',
    'proprietary information', 'confidentiality'
  ];
  if (poisonKeywords.some(word => lowerText.includes(word) || lowerDesc.includes(word))) return false;

  // Filter out raw assembly or machine code heuristics
  const assemblyHeuristic = /\b(mov|push|pop|jmp|call|ret|int|add|sub|xor|nop|lea|cmp)\b/i;
  if (assemblyHeuristic.test(text) || assemblyHeuristic.test(description || '')) return false;
  if (/[0-9a-f]{2,}\s[0-9a-f]{2,}\s[0-9a-f]{2,}/i.test(text)) return false;

  return true;
}

export async function discoverAvailableGeminiModels(): Promise<string[]> {
  return [...CANDIDATE_MODELS];
}

export interface SearchExtractionResult {
  results: WebPageGenotype[];
  artifacts: {
    groundingChunks?: any[];
    searchSummary?: string;
  };
  generationNote?: string;
  sourceMode: WebBookSourceMode;
  fallbackSource?: any;
  fallbackReason?: SearchFallbackReason;
}

interface VerifiedGroundingSource {
  uri: string;
  title: string;
  domain: string;
}

function extractVerifiedGroundingSources(response: any): VerifiedGroundingSource[] {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const verified: VerifiedGroundingSource[] = [];

  for (const c of chunks) {
    const uri = String(c?.web?.uri || c?.uri || '').trim();
    const title = String(c?.web?.title || c?.title || '').trim();
    if (uri && /^https?:\/\//i.test(uri)) {
      try {
        const parsed = new URL(uri);
        const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        if (!verified.some(v => v.uri === uri)) {
          verified.push({ uri, title, domain });
        }
      } catch {
        // ignore invalid URL
      }
    }
  }

  return verified;
}

function resolveVerifiedSource(
  rawItem: any,
  index: number,
  verifiedSources: VerifiedGroundingSource[]
): { url: string; title: string } {
  const rawUrl = String(rawItem?.url || '').trim();
  const rawTitle = String(rawItem?.title || '').trim();

  // 1. Direct URL match with verified grounding
  const directMatch = verifiedSources.find(v => v.uri === rawUrl);
  if (directMatch) {
    return { url: directMatch.uri, title: directMatch.title || rawTitle };
  }

  // 2. Domain and path matching against verified grounding
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    try {
      const parsedRaw = new URL(rawUrl);
      const rawDomain = parsedRaw.hostname.replace(/^www\./i, '').toLowerCase();
      const domainMatches = verifiedSources.filter(v => v.domain === rawDomain);

      if (domainMatches.length === 1) {
        return { url: domainMatches[0].uri, title: domainMatches[0].title || rawTitle };
      }

      if (domainMatches.length > 1) {
        const rawWords = parsedRaw.pathname.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        let best = domainMatches[0];
        let bestScore = -1;
        for (const candidate of domainMatches) {
          const candWords = new URL(candidate.uri).pathname.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
          const score = rawWords.filter(w => candWords.includes(w)).length;
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        return { url: best.uri, title: best.title || rawTitle };
      }
    } catch {
      // not a valid URL
    }
  }

  // 3. Match by title similarity against verified grounding
  if (rawTitle && verifiedSources.length > 0) {
    const rawLower = rawTitle.toLowerCase();
    const titleMatch = verifiedSources.find(v => 
      v.title && (v.title.toLowerCase().includes(rawLower) || rawLower.includes(v.title.toLowerCase()))
    );
    if (titleMatch) {
      return { url: titleMatch.uri, title: titleMatch.title };
    }
  }

  // 4. Align by index with verified grounding sources
  if (index < verifiedSources.length) {
    return { url: verifiedSources[index].uri, title: verifiedSources[index].title || rawTitle };
  }

  // 5. Pick from verified grounding if available
  if (verifiedSources.length > 0) {
    const picked = verifiedSources[index % verifiedSources.length];
    return { url: picked.uri, title: picked.title || rawTitle };
  }

  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      if (!u.hostname.includes('source-') && u.hostname !== 'knowledge-base.org') {
        return { url: rawUrl, title: rawTitle || 'Source Article' };
      }
    } catch {
      // ignore
    }
  }

  return { url: '', title: rawTitle || 'Source Article' };
}

// Why the Gemini search step did not supply the evidence (drives the notice and fallbackReason).
type GeminiSearchCause = GeminiFailureReason | 'no_content' | 'model_unavailable';

const GEMINI_SEARCH_CAUSE_PHRASES: Record<GeminiSearchCause, string> = {
  quota_or_rate_limit: 'usage limit reached',
  invalid_api_key: 'API key rejected',
  missing_api_key: 'API key missing',
  service_unavailable: 'service temporarily unavailable',
  network_unreachable: 'could not be reached',
  no_content: 'no usable sources returned',
  model_unavailable: 'model not available',
};

const GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON: Record<GeminiSearchCause, SearchFallbackReason> = {
  quota_or_rate_limit: 'quota_exhausted',
  invalid_api_key: 'unreachable',
  missing_api_key: 'unreachable',
  service_unavailable: 'unreachable',
  network_unreachable: 'network_unreachable',
  no_content: 'no_content',
  model_unavailable: 'unreachable',
};

function classifyGeminiSearchFailure(err: any): GeminiSearchCause {
  const message = String(err?.message || err || '');
  // Gemini answered but its text could not be parsed (e.g. cut off): a content problem, not an outage.
  if (err instanceof SyntaxError && !/<|doctype/i.test(message)) {
    return 'no_content';
  }
  const lowered = message.toLowerCase();
  if (
    Number(err?.status || err?.code) === 404 ||
    lowered.includes('not found') ||
    lowered.includes('is not supported') ||
    lowered.includes('unknown model')
  ) {
    return 'model_unavailable';
  }
  return detectGeminiFailureReason(err);
}

function describeFallbackProviders(mode: SearchFallbackMode): string {
  switch (mode) {
    case 'google':
      return 'The Google fallback search';
    case 'duckduckgo':
      return 'The DuckDuckGo fallback search';
    default:
      return 'The Google and DuckDuckGo fallback searches';
  }
}

// Graceful stop shown in the existing error box. It must keep the phrase "no external evidence could be
// gathered": useWebBookEngine uses it to avoid rewriting messages that mention "quota"/"429" as a rate limit.
function buildNoLiveEvidenceMessage(
  query: string,
  mode: SearchFallbackMode,
  model: string,
  cause: GeminiSearchCause
): string {
  return [
    `Search stopped: ${describeFallbackProviders(mode)} returned no live results (selected Gemini model ${model}: ${GEMINI_SEARCH_CAUSE_PHRASES[cause]}), so no external evidence could be gathered for "${query}". No Web-book was generated.`,
    '',
    'What you can do next:',
    '• Search again with the same wording - search engines often recover within a minute.',
    '• Refine the wording - use fewer, more specific keywords, name the key people, places or terms, or drop time-sensitive phrasing.',
  ].join('\n');
}

export async function searchAndExtract(
  query: string,
  options: EngineOptions = { mode: 'google_duckduckgo', geminiModel: 'gemini-3.8-flash' }
): Promise<SearchExtractionResult> {
  const fallbackEnabled = options.mode !== 'off';
  const selectedModel = options.geminiModel || 'gemini-3.8-flash';
  let geminiCause: GeminiSearchCause = 'no_content';

  try {
    const ai = getAI();
    const preferredModel = options.geminiModel || 'gemini-3.8-flash';

    const response = await generateWithModelFallback(ai, {
      contents: `Search for comprehensive information about "${query}". 
      Identify at least 5 distinct high-quality web pages or sources from the search results. 
      For each source, extract:
      1. The exact, real URL verbatim from the search grounding results (never alter, truncate, or invent URLs).
      2. The title of the page.
      3. A list of key definitions found on the page.
      4. A list of salient sub-topics discussed.
      5. A summary of the content.
      6. An assessment of its "Informative Value" (0-1) based on depth of definitions.
      7. An assessment of its "Authority" (0-1) based on source credibility.`,
      config: {
        systemInstruction: "You are a precise data extractor. Extract only real, meaningful definitions and sub-topics from the search results. CRITICAL: For the 'url' property, use ONLY the exact, real URLs returned by Google Search grounding. Never invent, hallucinate, alter, or predict non-existent URLs. If no meaningful definitions are found for a source, return an empty array for that source's definitions.",
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        maxOutputTokens: 4000,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              url: { type: Type.STRING },
              title: { type: Type.STRING },
              content: { type: Type.STRING },
              definitions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    term: { type: Type.STRING },
                    description: { type: Type.STRING }
                  },
                  required: ["term", "description"]
                }
              },
              subTopics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING }
                  },
                  required: ["title", "summary"]
                }
              },
              informativeScore: { type: Type.NUMBER },
              authorityScore: { type: Type.NUMBER }
            },
            required: ["url", "title", "content", "definitions", "subTopics", "informativeScore", "authorityScore"]
          }
        }
      }
    }, preferredModel);

    let parsed: any[] = [];
    const rawText = (response.text || "").trim();
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = JSON.parse(repairTruncatedJSON(rawText));
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      const verifiedGrounding = extractVerifiedGroundingSources(response);
      const population: WebPageGenotype[] = parsed.map((r: any, index: number) => {
        const resolved = resolveVerifiedSource(r, index, verifiedGrounding);
        const sourceUrl = resolved.url;
        const sourceTitle = resolved.title || r.title || `Source ${index + 1}`;

        return {
          id: `gen-${index}-${Date.now()}`,
          url: sourceUrl,
          title: sourceTitle,
          content: r.content ? r.content.substring(0, 2000) : "",
          definitions: (r.definitions || [])
            .filter((d: any) => isMeaningful(d.term, d.description))
            .map((d: any) => ({ ...d, sourceUrl })),
          subTopics: (r.subTopics || [])
            .filter((s: any) => isMeaningful(s.title, s.summary))
            .map((s: any) => ({ ...s, sourceUrl })),
          informativeScore: typeof r.informativeScore === 'number' ? r.informativeScore : 0.8,
          authorityScore: typeof r.authorityScore === 'number' ? r.authorityScore : 0.8,
          fitness: 0,
        };
      });

      const groundingChunks = (response.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map((c: any) => ({
        web: {
          uri: c.web?.uri || c.uri || '',
          title: c.web?.title || c.title || '',
        }
      }));

      return {
        results: population,
        artifacts: {
          groundingChunks,
          searchSummary: `Gemini extracted ${population.length} grounded sources for "${query}".`,
        },
        generationNote: `Evidence gathered via Google Search grounding by the selected Gemini model: ${selectedModel}.`,
        sourceMode: 'gemini',
      };
    }
  } catch (geminiError: any) {
    console.warn("Gemini search failed or unavailable, checking fallback...", geminiError);
    geminiCause = classifyGeminiSearchFailure(geminiError);

    if (!fallbackEnabled) {
      if (geminiCause === 'model_unavailable') {
        throw new Error(`Selected Gemini model: ${selectedModel} is not available. Choose another model and try again.`);
      }
      const reason = detectGeminiFailureReason(geminiError);
      throw new Error(buildGeminiUserFacingErrorMessage(geminiError, reason));
    }
  }

  // Fallback search execution
  const fallbackPayload = await fetchGoogleSearchFallback(query, options);
  // A synthetic payload is a placeholder the server fabricates when Google and DuckDuckGo both return nothing.
  // Building a book from it would present generic filler as researched evidence, so stop and let the user retry or refine.
  if (
    !fallbackPayload
    || !Array.isArray(fallbackPayload.results)
    || fallbackPayload.results.length === 0
    || isSyntheticFallbackPayload(fallbackPayload)
  ) {
    throw new Error(buildNoLiveEvidenceMessage(query, options.mode, selectedModel, geminiCause));
  }

  const fallbackEvidence = describeFallbackEvidence(fallbackPayload, options.mode);

  const fallbackPopulation: WebPageGenotype[] = fallbackPayload.results.map((res, index) => {
    const rawContent = [res.snippet, res.excerpt].filter(Boolean).join(' ');
    // Extract key sentences as definitions / subtopics
    const sentences = rawContent.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 20);

    const definitions: Definition[] = sentences.slice(0, 3).map((sent, i) => {
      const parts = sent.split(/:\s*|\s+is\s+|\s+refers to\s+/i);
      const term = parts.length > 1 ? parts[0].slice(0, 40) : `Concept ${i + 1}`;
      const description = parts.length > 1 ? parts.slice(1).join(' ') : sent;
      return {
        term: term.trim(),
        description: description.trim(),
        sourceUrl: res.url,
      };
    }).filter(d => isMeaningful(d.term, d.description));

    const subTopics: SubTopic[] = sentences.slice(2, 5).map((sent, i) => ({
      title: `${res.title.slice(0, 35)} - Key Area ${i + 1}`,
      summary: sent,
      sourceUrl: res.url,
    })).filter(s => isMeaningful(s.title, s.summary));

    return {
      id: `fallback-${index}-${Date.now()}`,
      url: res.url,
      title: res.title,
      content: rawContent || res.title,
      definitions,
      subTopics,
      informativeScore: 0.85,
      authorityScore: 0.9,
      fitness: 0,
    };
  });

  return {
    results: fallbackPopulation,
    artifacts: {
      groundingChunks: fallbackPayload.results.map(r => ({ web: { uri: r.url, title: r.title } })),
      searchSummary: fallbackPayload.summary || `Live fallback search retrieved ${fallbackPayload.results.length} sources via ${fallbackPayload.provider}.`,
    },
    generationNote: `Selected Gemini model: ${selectedModel} unavailable (${GEMINI_SEARCH_CAUSE_PHRASES[geminiCause]}); gathered evidence via ${fallbackEvidence.label}.`,
    sourceMode: 'fallback_search',
    fallbackSource: fallbackEvidence.source,
    fallbackReason: GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON[geminiCause],
  };
}

export function calculateFitness(
  page: WebPageGenotype,
  optimalSet: WebPageGenotype[],
  weights: { alpha: number; beta: number; gamma: number }
): number {
  const { alpha, beta, gamma } = weights;

  let redundancy = 0;
  if (optimalSet.length > 0) {
    const currentTerms = new Set(optimalSet.flatMap(p => (p.definitions || []).map(d => (d.term || "").toLowerCase())));
    const pageTerms = (page.definitions || []).map(d => (d.term || "").toLowerCase());
    const overlap = pageTerms.filter(t => t && currentTerms.has(t)).length;
    redundancy = overlap / Math.max(pageTerms.length, 1);
  }

  return (alpha * page.informativeScore) + (beta * page.authorityScore) - (gamma * redundancy);
}

export async function evolve(
  population: WebPageGenotype[],
  generations: number = 3
): Promise<{ population: WebPageGenotype[]; completedGenerations: number; bestRedundancyPenalty: number }> {
  let currentPopulation = [...population];
  const weights = { alpha: 0.5, beta: 0.3, gamma: 0.2 };
  let bestRedundancyPenalty = 0;

  for (let g = 0; g < generations; g++) {
    currentPopulation.forEach(p => {
      p.fitness = calculateFitness(p, [], weights);
    });

    currentPopulation.sort((a, b) => b.fitness - a.fitness);
    const survivors = currentPopulation.slice(0, Math.max(2, Math.ceil(currentPopulation.length / 2)));

    const offspring: WebPageGenotype[] = [];
    for (let i = 0; i < survivors.length - 1; i += 2) {
      const parentA = survivors[i];
      const parentB = survivors[i + 1];

      const child: WebPageGenotype = {
        id: `offspring-${g}-${i}`,
        url: parentA.url || parentB.url,
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: `${parentA.content.substring(0, 500)}... ${parentB.content.substring(0, 500)}...`,
        definitions: [
          ...(parentA.definitions || []).slice(0, Math.ceil((parentA.definitions?.length || 0) / 2)),
          ...(parentB.definitions || []).slice(Math.ceil((parentB.definitions?.length || 0) / 2))
        ],
        subTopics: [
          ...(parentA.subTopics || []).slice(0, Math.ceil((parentA.subTopics?.length || 0) / 2)),
          ...(parentB.subTopics || []).slice(Math.ceil((parentB.subTopics?.length || 0) / 2))
        ],
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0
      };
      offspring.push(child);
    }

    currentPopulation = [...survivors, ...offspring];
  }

  // Calculate best redundancy penalty
  if (currentPopulation.length > 1) {
    const terms = currentPopulation.map(p => (p.definitions || []).map(d => d.term.toLowerCase()));
    let overlapCount = 0;
    for (let i = 0; i < terms.length; i++) {
      for (let j = i + 1; j < terms.length; j++) {
        overlapCount += terms[i].filter(t => terms[j].includes(t)).length;
      }
    }
    bestRedundancyPenalty = Math.min(1, overlapCount / Math.max(1, currentPopulation.length * 4));
  }

  return {
    population: currentPopulation,
    completedGenerations: generations,
    bestRedundancyPenalty,
  };
}

function synthesizeFallbackWebBook(
  topic: string,
  sources: WebPageGenotype[],
  searchResult?: any
): WebBook {
  const allDefinitions: Definition[] = [];
  const allSubTopics: SubTopic[] = [];
  const validSources = sources
    .filter(s => s.url && /^https?:\/\//i.test(s.url) && !s.url.includes('source-') && !s.url.includes('knowledge-base.org'))
    .map(s => ({ title: s.title, url: s.url }));

  sources.forEach(s => {
    (s.definitions || []).forEach(d => {
      if (isMeaningful(d.term, d.description)) allDefinitions.push(d);
    });
    (s.subTopics || []).forEach(st => {
      if (isMeaningful(st.title, st.summary)) allSubTopics.push(st);
    });
  });

  const chapterBlueprints = [
    { title: "Foundations & Historical Perspective", seed: "origins and emergence" },
    { title: "Core Architecture & Conceptual Framework", seed: "structural blueprint" },
    { title: "Key Principles, Mechanics & Methodologies", seed: "mechanics and processes" },
    { title: "Operational Dynamics & Real-World Execution", seed: "practical implementation" },
    { title: "Comparative Evaluation & Systemic Analysis", seed: "analysis and paradigms" },
    { title: "Future Outlook, Challenges & Horizons", seed: "frontiers and future" }
  ];

  const chapters: Chapter[] = chapterBlueprints.map((bp, idx) => {
    const relevantSource = validSources[idx % validSources.length] || validSources[0] || null;
    const defsForChapter = allDefinitions.slice(idx * 2, idx * 2 + 3);
    const subTopicsForChapter = allSubTopics.slice(idx * 2, idx * 2 + 2);

    const narrative = [
      `${topic} represents a transformative discipline characterized by multifaceted evolution and practical significance. In ${bp.title.toLowerCase()}, foundational principles coalesce with modern analytical frameworks to illuminate key characteristics and real-world mechanisms.`,
      relevantSource ? `Inquiring into authoritative evidence on ${relevantSource.title || topic} establishes key characteristics and structural methodologies. As research and application paradigms evolve, synthesis of evidence underscores the imperative for continuous refinement.` : `Comprehensive inquiry into ${topic} emphasizes precision, structural cohesion, and cross-domain utility. As research and application paradigms evolve, synthesis of evidence underscores the imperative for continuous refinement.`,
      `Critical examination reveals that advancing in ${topic} requires balancing foundational rigor against evolving operational demands. By integrating authoritative evidence and systematic paradigms, practitioners ensure sustainable, high-impact outcomes.`
    ].join('\n\n');

    return {
      title: bp.title,
      content: narrative,
      definitions: defsForChapter.length > 0 ? defsForChapter : [
        { term: `${topic} Principle ${idx + 1}`, description: `Essential operational principle governing ${bp.title.toLowerCase()} within ${topic}.`, sourceUrl: relevantSource?.url || '' }
      ],
      subTopics: subTopicsForChapter.length > 0 ? subTopicsForChapter : [
        { title: `${bp.title} In Depth`, summary: `Detailed exploration of strategic elements shaping modern implementations.`, sourceUrl: relevantSource?.url || '' }
      ],
      sourceUrls: relevantSource ? [{ title: relevantSource.title, url: relevantSource.url }] : validSources.slice(0, 3),
      visualSeed: `${topic} ${bp.seed}`,
    };
  });

  return {
    id: `book-${Date.now()}`,
    topic,
    timestamp: Date.now(),
    chapters,
    sourceMode: searchResult?.sourceMode || 'fallback_search',
    generationNote: searchResult?.generationNote || 'Synthesized via resilient multi-source evolutionary engine.',
    fallbackSource: searchResult?.fallbackSource,
    fallbackReason: searchResult?.fallbackReason,
  };
}

export async function assembleWebBook(
  optimalPopulation: WebPageGenotype[],
  topic: string,
  searchResult?: any,
  options?: EngineOptions
): Promise<WebBook> {
  const verifiedSourcesPool: Array<{ title: string; url: string }> = [];
  const poolSeen = new Set<string>();

  const addCandidateSource = (title?: string, url?: string) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl) || poolSeen.has(cleanUrl)) return;
    try {
      const u = new URL(cleanUrl);
      if (u.hostname.includes('source-') || u.hostname === 'knowledge-base.org') return;
      poolSeen.add(cleanUrl);
      verifiedSourcesPool.push({
        title: String(title || u.hostname).trim(),
        url: cleanUrl,
      });
    } catch {
      // ignore
    }
  };

  optimalPopulation.forEach(p => addCandidateSource(p.title, p.url));
  (searchResult?.artifacts?.groundingChunks || []).forEach((c: any) => {
    addCandidateSource(c.web?.title || c.title, c.web?.uri || c.uri);
  });

  const truncatedData = optimalPopulation.slice(0, ASSEMBLY_SOURCE_POOL_SIZE).map(p => ({
    title: p.title,
    url: p.url,
    content: p.content.substring(0, 1000),
    definitions: p.definitions.slice(0, 4),
    subTopics: p.subTopics.slice(0, 3)
  }));

  const preferredModel = options?.geminiModel || DEFAULT_GEMINI_MODEL;
  let assemblyFailure: unknown = null;

  try {
    const ai = getAI();

    // Stage 1: Generate detailed 10-chapter outline
    const outlineResponse = await generateWithModelFallback(ai, {
      contents: `Topic: ${topic}. Data: ${JSON.stringify(truncatedData)}. 
      Create a detailed 10-chapter outline for a comprehensive, full-length Web-book. 
      For each chapter, provide:
      1. A compelling title.
      2. A brief 2-sentence focus description.
      3. 3 key terms to define.
      4. 2 sub-topics to explore.
      5. A visual seed keyword for an image.`,
      config: {
        systemInstruction: "You are a master book architect. Output valid JSON only. Create a 10-chapter outline that flows logically from introduction to advanced concepts and future outlook. Ensure all terms and sub-topics are meaningful and relevant to the topic. Strictly avoid placeholders, random strings, or meaningless identifiers.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            topic: { type: Type.STRING },
            outline: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  focus: { type: Type.STRING },
                  terms: { type: Type.ARRAY, items: { type: Type.STRING } },
                  subTopicTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
                  visualSeed: { type: Type.STRING }
                },
                required: ["title", "focus", "terms", "subTopicTitles", "visualSeed"]
              }
            }
          },
          required: ["topic", "outline"]
        }
      }
    }, preferredModel);

    let outlineData: any;
    try {
      outlineData = JSON.parse(outlineResponse.text);
    } catch {
      outlineData = JSON.parse(repairTruncatedJSON(outlineResponse.text));
    }

    if (outlineData && Array.isArray(outlineData.outline) && outlineData.outline.length > 0) {
      // Stage 2: Parallel chapter expansion (enriched 350-400 words per chapter)
      const chapterPromises = outlineData.outline.map(async (chapterOutline: any, chapterIndex: number) => {
        const chapterResponse = await generateWithModelFallback(ai, {
          contents: `Topic: ${topic}. Chapter: ${chapterOutline.title}. Focus: ${chapterOutline.focus}. 
          Write a comprehensive, high-quality chapter (approx 350-400 words). 
          Also provide detailed definitions for: ${(chapterOutline.terms || []).join(', ')}.
          And detailed analyses for the sub-topics: ${(chapterOutline.subTopicTitles || []).join(', ')}.`,
          config: {
            systemInstruction: "You are an expert technical writer. Output valid JSON only. Be detailed, authoritative, and academic in tone. Ensure all definitions and sub-topic analyses are meaningful, human-readable, and relevant to the chapter. Strictly avoid generating random numbers, long strings of digits, or meaningless placeholder text.",
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                content: { type: Type.STRING },
                definitions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      term: { type: Type.STRING },
                      description: { type: Type.STRING }
                    }
                  }
                },
                subTopics: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      summary: { type: Type.STRING }
                    }
                  }
                }
              },
              required: ["content", "definitions", "subTopics"]
            }
          }
        }, preferredModel);

        let chapterData: any;
        try {
          chapterData = JSON.parse(chapterResponse.text);
        } catch {
          chapterData = JSON.parse(repairTruncatedJSON(chapterResponse.text));
        }

        const chapterSourceIndex = chapterIndex % Math.max(1, verifiedSourcesPool.length);
        const chapterSources = verifiedSourcesPool.length > 0
          ? [
              verifiedSourcesPool[chapterSourceIndex],
              verifiedSourcesPool[(chapterSourceIndex + 1) % verifiedSourcesPool.length],
            ].filter(Boolean)
          : [];
        const primaryUrl = chapterSources[0]?.url || (verifiedSourcesPool[0]?.url || '');

        return {
          title: chapterOutline.title,
          content: chapterData?.content || `${chapterOutline.focus}\n\nComprehensive exploration of ${chapterOutline.title} reveals interconnected principles and transformative implementations across the domain.`,
          definitions: (chapterData?.definitions || [])
            .filter((d: any) => isMeaningful(d.term, d.description))
            .map((d: any) => ({ ...d, sourceUrl: primaryUrl })),
          subTopics: (chapterData?.subTopics || [])
            .filter((s: any) => isMeaningful(s.title, s.summary))
            .map((s: any) => ({ ...s, sourceUrl: primaryUrl })),
          sourceUrls: chapterSources.length > 0 ? chapterSources : verifiedSourcesPool.slice(0, 3),
          visualSeed: chapterOutline.visualSeed || `${topic} ${chapterOutline.title}`,
        };
      });

      const chapters = await Promise.all(chapterPromises);

      return {
        id: `book-${Date.now()}`,
        topic: outlineData.topic || topic,
        timestamp: Date.now(),
        chapters,
        sourceMode: searchResult?.sourceMode || 'gemini',
        generationNote: searchResult?.generationNote || 'Assembled via 2-stage evolutionary architecture.',
        fallbackSource: searchResult?.fallbackSource,
        fallbackReason: searchResult?.fallbackReason,
      };
    }
    assemblyFailure = new SyntaxError('Gemini returned an empty book outline');
  } catch (err) {
    console.warn("AI outline / chapter expansion failed, falling back to resilient synthesis...", err);
    assemblyFailure = err;
  }

  // Gemini-only mode never recovers silently: report the failure instead of presenting an offline book.
  if (options?.mode === 'off' && assemblyFailure) {
    const cause = classifyGeminiSearchFailure(assemblyFailure);
    if (cause === 'model_unavailable') {
      throw new Error(`Selected Gemini model: ${preferredModel} is not available. Choose another model and try again.`);
    }
    if (cause === 'no_content') {
      throw new Error(`Selected Gemini model: ${preferredModel} returned no usable book content. Please try again.`);
    }
    throw new Error(buildGeminiUserFacingErrorMessage(assemblyFailure, detectGeminiFailureReason(assemblyFailure)));
  }

  // Graceful resilient fallback synthesis: ensures no alerts/crashes when Gemini quota is met.
  // The notice must describe what really happened, not the (successful) search step that preceded it.
  if (assemblyFailure) {
    const cause = classifyGeminiSearchFailure(assemblyFailure);
    const assemblyNote = `Selected Gemini model: ${preferredModel} unavailable for book assembly (${cause === 'no_content' ? 'no usable content returned' : GEMINI_SEARCH_CAUSE_PHRASES[cause]}); book text assembled offline from the gathered evidence.`;
    const searchWasGemini = searchResult?.sourceMode === 'gemini';
    return synthesizeFallbackWebBook(topic, optimalPopulation, {
      ...(searchResult || {}),
      sourceMode: searchWasGemini ? 'hybrid' : (searchResult?.sourceMode || 'fallback_search'),
      generationNote: `${searchResult?.generationNote ? `${searchResult.generationNote} ` : ''}${assemblyNote}`,
      fallbackReason: searchResult?.fallbackReason ?? GEMINI_SEARCH_CAUSE_TO_FALLBACK_REASON[cause],
    });
  }
  return synthesizeFallbackWebBook(topic, optimalPopulation, searchResult);
}
