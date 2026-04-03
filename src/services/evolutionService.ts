import { GoogleGenAI, Type } from '@google/genai';
import type {
  SearchArtifact,
  SearchFallbackPayload,
  SearchFallbackProvider,
  SearchFallbackReason,
  SearchFallbackResult,
  SearchFallbackSource,
  WebBook,
  WebBookSourceMode,
  WebPageGenotype,
} from '../types';
import { fetchGoogleSearchFallback } from './googleSearchFallbackClient';
import { getRenderableDefinitions, getRenderableSubTopics, isMeaningfulText } from '../utils/webBookRender';

export interface SearchAndExtractResult {
  results: WebPageGenotype[];
  artifacts: {
    groundingChunks: SearchArtifact[];
    searchSummary?: string;
  };
  sourceMode: WebBookSourceMode;
  generationNote?: string;
  fallbackSource?: SearchFallbackSource;
  fallbackReason?: SearchFallbackReason;
  fallbackPayload?: SearchFallbackPayload;
}

const GEMINI_MODEL = 'gemini-3-flash-preview';
const FALLBACK_SOURCE_URL = 'https://www.google.com/search';
const FALLBACK_STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'amid',
  'among',
  'and',
  'around',
  'been',
  'between',
  'from',
  'into',
  'over',
  'that',
  'their',
  'them',
  'they',
  'this',
  'through',
  'under',
  'with',
]);

const getAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY_MISSING');
  }
  return new GoogleGenAI({ apiKey });
};

async function withRetry<T>(fn: () => Promise<T>, retries = 5, delay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
    const errorMessage = error.message || errorStr || '';

    const isRetryable =
      errorMessage.includes('429') ||
      errorMessage.includes('quota') ||
      errorMessage.includes('RESOURCE_EXHAUSTED') ||
      errorMessage.includes('500') ||
      errorMessage.includes('503') ||
      errorMessage.includes('INTERNAL') ||
      errorMessage.includes('Internal error') ||
      errorMessage.includes('Service Unavailable') ||
      error.code === 500 ||
      error.status === 'INTERNAL';

    if (retries > 0 && isRetryable) {
      console.warn(`Retrying API call due to error: ${errorMessage.substring(0, 200)}. Retries left: ${retries}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      const nextDelay = delay * 2 + Math.random() * 1000;
      return withRetry(fn, retries - 1, nextDelay);
    }
    throw error;
  }
}

function repairTruncatedJSON(jsonString: string): string {
  const attemptRepair = (input: string) => {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
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
        const last = stack[stack.length - 1];
        if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
          stack.pop();
        }
      }
    }

    let repaired = input;
    if (inString) repaired += '"';
    while (stack.length > 0) {
      const last = stack.pop();
      repaired += last === '{' ? '}' : ']';
    }
    return repaired;
  };

  const firstTry = attemptRepair(jsonString);
  try {
    JSON.parse(firstTry);
    return firstTry;
  } catch {
    let lastComma = jsonString.lastIndexOf(',');
    while (lastComma > 0) {
      const secondTry = attemptRepair(jsonString.substring(0, lastComma));
      try {
        JSON.parse(secondTry);
        return secondTry;
      } catch {
        lastComma = jsonString.lastIndexOf(',', lastComma - 1);
      }
    }
  }

  return firstTry;
}

function parseJsonResponse<T>(rawText: string, fallbackMessage: string): T {
  try {
    return JSON.parse(rawText) as T;
  } catch {
    try {
      return JSON.parse(repairTruncatedJSON(rawText)) as T;
    } catch {
      console.error('Failed to parse model JSON:', rawText);
      throw new Error(fallbackMessage);
    }
  }
}

function classifyGeminiError(error: unknown): SearchFallbackReason | null {
  const message = typeof error === 'string'
    ? error.toLowerCase()
    : JSON.stringify(error).toLowerCase() + ' ' + String((error as { message?: string })?.message || '').toLowerCase();

  if (message.includes('gemini_api_key_missing')) {
    return 'missing_api_key';
  }
  if (message.includes('api_key_invalid') || message.includes('invalid api key') || message.includes('403') || message.includes('401')) {
    return 'invalid_api_key';
  }
  if (message.includes('429') || message.includes('quota') || message.includes('resource_exhausted') || message.includes('rate limit')) {
    return 'quota_or_rate_limit';
  }
  if (message.includes('503') || message.includes('500') || message.includes('service unavailable') || message.includes('internal error')) {
    return 'service_unavailable';
  }
  return null;
}

function buildFallbackNotice(
  reason: SearchFallbackReason,
  source: SearchFallbackSource,
  provider: SearchFallbackProvider = 'google'
): string {
  const reasonText = {
    missing_api_key: 'Gemini API key is missing',
    invalid_api_key: 'Gemini API key is invalid or rejected',
    quota_or_rate_limit: 'Gemini API quota or rate limit was reached',
    service_unavailable: 'Gemini API is temporarily unavailable',
  }[reason];

  const sourceText = source === 'google-ai-overview'
    ? 'Google Search AI Overview'
    : source === 'google-search-snippets'
      ? 'top Google Search snippets'
      : `${provider === 'duckduckgo' ? 'DuckDuckGo' : 'alternate'} search snippets`;

  const searchNote = source === 'alternate-search-snippets'
    ? `Google Search blocked automated extraction, so the engine switched to ${sourceText}`
    : `using ${sourceText}`;

  return `${reasonText}; ${searchNote} to synthesize this Web-book from live search results.`;
}

function buildSearchUrl(query: string): string {
  return `${FALLBACK_SOURCE_URL}?q=${encodeURIComponent(query)}`;
}

function scoreDomainAuthority(url: string): number {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    if (hostname.endsWith('.gov')) return 0.96;
    if (hostname.endsWith('.edu')) return 0.92;
    if (hostname.includes('wikipedia.org')) return 0.88;
    if (hostname.endsWith('.org')) return 0.82;
    if (hostname.includes('reuters.com') || hostname.includes('apnews.com') || hostname.includes('bbc.com')) return 0.84;
    return 0.72;
  } catch {
    return 0.65;
  }
}

function scoreInformativeText(text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const sentenceCount = text.split(/[.!?]+/).filter((segment) => segment.trim().length > 0).length;
  return Math.min(0.98, 0.35 + Math.min(wordCount / 180, 0.38) + Math.min(sentenceCount / 10, 0.25));
}

function deriveConceptLabel(title: string, fallbackQuery: string): string {
  const firstSegment = title.split(/[-:|]/)[0]?.trim();
  if (firstSegment && firstSegment.length >= 4) {
    return firstSegment;
  }
  return fallbackQuery;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeComparableText(text: string): string[] {
  return normalizeComparableText(text)
    .split(' ')
    .filter((token) => token.length >= 3 && !FALLBACK_STOPWORDS.has(token));
}

function calculateTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  if (shorter.length >= 32 && longer.includes(shorter)) {
    return 0.96;
  }

  const leftTokens = new Set(tokenizeComparableText(left));
  const rightTokens = new Set(tokenizeComparableText(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / new Set([...leftTokens, ...rightTokens]).size;
}

function dedupeSentences(text: string, maxSentences = Number.POSITIVE_INFINITY): string[] {
  const unique: string[] = [];

  for (const sentence of splitSentences(text)) {
    if (sentence.length < 35) {
      continue;
    }

    if (unique.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
      continue;
    }

    unique.push(sentence);
    if (unique.length >= maxSentences) {
      break;
    }
  }

  return unique;
}

function sanitizeFallbackSnippet(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();

  const uniqueSentences = dedupeSentences(cleaned, 4);
  if (uniqueSentences.length > 0) {
    return uniqueSentences.join(' ');
  }

  return cleaned;
}

function selectDistinctFallbackResults(results: SearchFallbackResult[], maxResults = 5): SearchFallbackResult[] {
  const distinct: SearchFallbackResult[] = [];

  for (const result of results) {
    const candidate: SearchFallbackResult = {
      ...result,
      title: result.title.trim(),
      snippet: sanitizeFallbackSnippet(result.snippet),
    };

    if (!candidate.title || !candidate.snippet) {
      continue;
    }

    const isDuplicate = distinct.some((existing) => {
      if (existing.url === candidate.url) {
        return true;
      }

      const titleSimilarity = calculateTextSimilarity(existing.title, candidate.title);
      const snippetSimilarity = calculateTextSimilarity(existing.snippet, candidate.snippet);
      return titleSimilarity >= 0.78 || (titleSimilarity >= 0.58 && snippetSimilarity >= 0.72) || snippetSimilarity >= 0.9;
    });

    if (isDuplicate) {
      continue;
    }

    distinct.push(candidate);
    if (distinct.length >= maxResults) {
      break;
    }
  }

  return distinct;
}

function isSyntheticPage(page: WebPageGenotype): boolean {
  return page.url === 'hybrid-source' || page.title.toLowerCase().startsWith('synthesized:');
}

function buildSearchSummaryFromPopulation(population: WebPageGenotype[], topic: string): string {
  const collected: string[] = [];

  for (const page of population) {
    for (const sentence of dedupeSentences(page.content, 5)) {
      if (collected.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
        continue;
      }

      collected.push(sentence);
      if (collected.join(' ').length >= 1200) {
        return collected.join(' ');
      }
    }
  }

  if (collected.length > 0) {
    return collected.join(' ');
  }

  return `Search evidence for ${topic} was gathered, but only a limited amount of extractable text was available.`;
}

function mapFallbackArtifacts(payload: SearchFallbackPayload): SearchArtifact[] {
  return payload.results.map((result) => ({
    web: {
      title: result.title,
      uri: result.url,
    },
    snippet: result.snippet,
  }));
}

function buildFallbackPopulation(payload: SearchFallbackPayload): WebPageGenotype[] {
  const searchUrl = buildSearchUrl(payload.query);
  const distinctResults = selectDistinctFallbackResults(payload.results);
  const overviewDefinitions = getRenderableDefinitions([
    {
      term: payload.query,
      description: payload.summary,
      sourceUrl: searchUrl,
    },
    ...distinctResults.slice(0, 3).map((result) => ({
      term: deriveConceptLabel(result.title, payload.query),
      description: result.snippet,
      sourceUrl: result.url,
    })),
  ]);

  const overviewSubTopics = getRenderableSubTopics(
    distinctResults.slice(0, 4).map((result) => ({
      title: result.title,
      summary: result.snippet,
      sourceUrl: result.url,
    }))
  );

  const overviewPage: WebPageGenotype = {
    id: `fallback-overview-${payload.extractedAt}`,
    url: searchUrl,
    title: payload.source === 'google-ai-overview' ? `${payload.query} - Google AI Overview` : `${payload.query} - Google Search Summary`,
    content: sanitizeFallbackSnippet(payload.summary),
    definitions: overviewDefinitions,
    subTopics: overviewSubTopics,
    informativeScore: scoreInformativeText(payload.summary),
    authorityScore: 0.82,
    fitness: 0,
  };

  const sourcePages = distinctResults.slice(0, 5).map((result, index) => ({
    id: `fallback-source-${index}-${payload.extractedAt}`,
    url: result.url,
    title: result.title,
    content: result.snippet,
    definitions: getRenderableDefinitions([
      {
        term: deriveConceptLabel(result.title, payload.query),
        description: result.snippet,
        sourceUrl: result.url,
      },
    ]),
    subTopics: getRenderableSubTopics([
      {
        title: result.title,
        summary: result.snippet,
        sourceUrl: result.url,
      },
    ]),
    informativeScore: scoreInformativeText(result.snippet),
    authorityScore: scoreDomainAuthority(result.url),
    fitness: 0,
  }));

  return [overviewPage, ...sourcePages];
}

async function searchAndExtractWithGemini(query: string): Promise<SearchAndExtractResult> {
  const ai = getAI();

  const response = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Search for comprehensive information about "${query}".
    Identify 3-5 distinct high-quality web pages or sources.
    For each source, extract:
    1. A list of key definitions found on the page.
    2. A list of salient sub-topics discussed.
    3. A summary of the content.
    4. An assessment of its "Informative Value" (0-1) based on depth of definitions.
    5. An assessment of its "Authority" (0-1) based on source credibility.`,
    config: {
      systemInstruction: 'You are a precise data extractor. Extract only real, meaningful definitions and sub-topics from the search results. Do not generate placeholder text, random numbers, or gibberish. If no meaningful definitions are found for a source, return an empty array for that source\'s definitions.',
      tools: [{ googleSearch: {} }],
      responseMimeType: 'application/json',
      maxOutputTokens: 6000,
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
                  description: { type: Type.STRING },
                },
                required: ['term', 'description'],
              },
            },
            subTopics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: Type.STRING },
                },
                required: ['title', 'summary'],
              },
            },
            informativeScore: { type: Type.NUMBER },
            authorityScore: { type: Type.NUMBER },
          },
          required: ['url', 'title', 'content', 'definitions', 'subTopics', 'informativeScore', 'authorityScore'],
        },
      },
    },
  }));

  const rawText = (response.text || '').trim();
  const rawGroundingChunks = (response.candidates?.[0]?.groundingMetadata as { groundingChunks?: SearchArtifact[] } | undefined)?.groundingChunks || [];
  if (!rawText) {
    return {
      results: [],
      artifacts: { groundingChunks: rawGroundingChunks },
      sourceMode: 'gemini',
    };
  }

  const results = parseJsonResponse<any[]>(rawText, 'The search engine returned an invalid response. Please try a different query.');
  if (!Array.isArray(results)) {
    return {
      results: [],
      artifacts: { groundingChunks: rawGroundingChunks },
      sourceMode: 'gemini',
    };
  }

  const processedResults = results.map((result: any, index: number) => ({
    ...result,
    id: `gen-${index}-${Date.now()}`,
    content: result.content ? String(result.content).substring(0, 2000) : '',
    definitions: (result.definitions || []).map((definition: any) => ({ ...definition, sourceUrl: result.url })),
    subTopics: (result.subTopics || []).map((subTopic: any) => ({ ...subTopic, sourceUrl: result.url })),
    fitness: 0,
  }));

  return {
    results: processedResults,
    artifacts: { groundingChunks: rawGroundingChunks },
    sourceMode: 'gemini',
  };
}

export async function searchAndExtract(query: string): Promise<SearchAndExtractResult> {
  try {
    return await searchAndExtractWithGemini(query);
  } catch (error) {
    const fallbackReason = classifyGeminiError(error);
    if (!fallbackReason) {
      throw error;
    }

    const fallbackPayload = await fetchGoogleSearchFallback(query);
    return {
      results: buildFallbackPopulation(fallbackPayload),
      artifacts: {
        groundingChunks: mapFallbackArtifacts(fallbackPayload),
        searchSummary: fallbackPayload.summary,
      },
      sourceMode: 'search-fallback',
      generationNote: buildFallbackNotice(fallbackReason, fallbackPayload.source, fallbackPayload.provider),
      fallbackSource: fallbackPayload.source,
      fallbackReason,
      fallbackPayload,
    };
  }
}

export function calculateFitness(
  page: WebPageGenotype,
  optimalSet: WebPageGenotype[],
  weights: { alpha: number; beta: number; gamma: number }
): number {
  const { alpha, beta, gamma } = weights;

  let redundancy = 0;
  if (optimalSet.length > 0) {
    const currentTerms = new Set(optimalSet.flatMap((candidate) => (candidate.definitions || []).map((definition) => (definition.term || '').toLowerCase())));
    const pageTerms = (page.definitions || []).map((definition) => (definition.term || '').toLowerCase());
    const overlap = pageTerms.filter((term) => term && currentTerms.has(term)).length;
    redundancy = overlap / Math.max(pageTerms.length, 1);
  }

  return (alpha * page.informativeScore) + (beta * page.authorityScore) - (gamma * redundancy);
}

export const EVOLUTION_WEIGHTS = { alpha: 0.5, beta: 0.3, gamma: 0.2 };

export async function evolve(population: WebPageGenotype[], generations = 3): Promise<WebPageGenotype[]> {
  let currentPopulation = [...population];

  for (let generation = 0; generation < generations; generation += 1) {
    currentPopulation.forEach((page) => {
      page.fitness = calculateFitness(page, [], EVOLUTION_WEIGHTS);
    });

    currentPopulation.sort((left, right) => right.fitness - left.fitness);
    const survivors = currentPopulation.slice(0, Math.ceil(currentPopulation.length / 2));

    const offspring: WebPageGenotype[] = [];
    for (let index = 0; index < survivors.length - 1; index += 2) {
      const parentA = survivors[index];
      const parentB = survivors[index + 1];

      offspring.push({
        id: `offspring-${generation}-${index}`,
        url: 'hybrid-source',
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: `${parentA.content.substring(0, 500)}... ${parentB.content.substring(0, 500)}...`,
        definitions: [
          ...(parentA.definitions || []).slice(0, Math.ceil((parentA.definitions?.length || 0) / 2)),
          ...(parentB.definitions || []).slice(Math.ceil((parentB.definitions?.length || 0) / 2)),
        ],
        subTopics: [
          ...(parentA.subTopics || []).slice(0, Math.ceil((parentA.subTopics?.length || 0) / 2)),
          ...(parentB.subTopics || []).slice(Math.ceil((parentB.subTopics?.length || 0) / 2)),
        ],
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0,
      });
    }

    currentPopulation = [...survivors, ...offspring];
  }

  return currentPopulation;
}

async function assembleWebBookWithGemini(optimalPopulation: WebPageGenotype[], topic: string): Promise<WebBook> {
  const ai = getAI();
  const truncatedData = optimalPopulation.slice(0, 5).map((page) => ({
    title: page.title,
    url: page.url,
    content: page.content.substring(0, 1000),
    definitions: page.definitions.slice(0, 4),
    subTopics: page.subTopics.slice(0, 3),
  }));

  const outlineResponse = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Topic: ${topic}. Data: ${JSON.stringify(truncatedData)}.
    Create a detailed 12-chapter candidate pool for a comprehensive Web-book.
    For each chapter, provide:
    1. A compelling title.
    2. A brief 2-sentence focus description.
    3. 3 key terms to define.
    4. 2 sub-topics to explore.
    5. A visual seed keyword for an image.
    6. A 'priorityScore' (1-100) representing how essential this chapter is to the core topic.`,
    config: {
      systemInstruction: 'You are a master book architect. Output valid JSON only. Create a 12-chapter candidate pool. This is an evolutionary selection process: some chapters will be pruned later based on quality. Ensure a logical flow from basics to advanced. Assign higher priorityScore to foundational and critical chapters. Strictly avoid placeholders or meaningless text.',
      responseMimeType: 'application/json',
      maxOutputTokens: 4096,
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
                visualSeed: { type: Type.STRING },
                priorityScore: { type: Type.NUMBER },
              },
              required: ['title', 'focus', 'terms', 'subTopicTitles', 'visualSeed', 'priorityScore'],
            },
          },
        },
        required: ['topic', 'outline'],
      },
    },
  }));

  const outlineData = parseJsonResponse<{ topic: string; outline: any[] }>(outlineResponse.text || '', 'The AI could not create a valid book outline.');
  if (!outlineData || !Array.isArray(outlineData.outline)) {
    throw new Error('The AI could not create a valid book outline.');
  }

  const allGeneratedChapters: Array<WebBook['chapters'][number] & { priorityScore: number; originalIndex: number }> = [];
  const concurrencyLimit = 3;

  for (let index = 0; index < outlineData.outline.length; index += concurrencyLimit) {
    const batch = outlineData.outline.slice(index, index + concurrencyLimit);
    const batchResults = await Promise.all(batch.map(async (chapterOutline: any, batchIndex: number) => {
      const chapterResponse = await withRetry(() => ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Topic: ${topic}. Chapter: ${chapterOutline.title}. Focus: ${chapterOutline.focus}.
        Write a comprehensive, high-quality chapter (approx 350-400 words).
        Also provide detailed definitions for: ${chapterOutline.terms.join(', ')}.
        And detailed analyses for the sub-topics: ${chapterOutline.subTopicTitles.join(', ')}.`,
        config: {
          systemInstruction: 'You are an expert technical writer. Output valid JSON only. Be detailed, authoritative, and academic in tone. Ensure all definitions and sub-topic analyses are meaningful, human-readable, and relevant to the chapter. Strictly avoid generating random numbers, long strings of digits, or meaningless placeholder text.',
          responseMimeType: 'application/json',
          maxOutputTokens: 4096,
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
                    description: { type: Type.STRING },
                  },
                },
              },
              subTopics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    summary: { type: Type.STRING },
                  },
                },
              },
            },
            required: ['content', 'definitions', 'subTopics'],
          },
        },
      }));

      const chapterData = parseJsonResponse<any>(chapterResponse.text || '', 'The AI returned an invalid chapter response.');
      const content = chapterData?.content;
      if (!content || !isMeaningfulText(content)) {
        return null;
      }

      const filteredDefinitions = getRenderableDefinitions(chapterData?.definitions || [])
        .map((definition: any) => ({ ...definition, sourceUrl: truncatedData[0]?.url || 'Synthesized' }));
      const filteredSubTopics = getRenderableSubTopics(chapterData?.subTopics || [])
        .map((subTopic: any) => ({ ...subTopic, sourceUrl: truncatedData[0]?.url || 'Synthesized' }));

      return {
        title: chapterOutline.title,
        content,
        definitions: filteredDefinitions,
        subTopics: filteredSubTopics,
        sourceUrls: truncatedData.map((data) => ({ title: data.title, url: data.url })),
        visualSeed: chapterOutline.visualSeed || 'evolution',
        priorityScore: chapterOutline.priorityScore || 50,
        originalIndex: index + batchIndex,
      };
    }));

    allGeneratedChapters.push(...batchResults.filter((chapter): chapter is NonNullable<typeof chapter> => Boolean(chapter)));

    if (index + concurrencyLimit < outlineData.outline.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const selectedChapters = allGeneratedChapters
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .slice(0, 10)
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map(({ priorityScore, originalIndex, ...chapter }) => chapter);

  return {
    topic: outlineData.topic,
    chapters: selectedChapters,
    id: `book-${Date.now()}`,
    timestamp: Date.now(),
  };
}

function filterNovelSentences(
  candidates: string[],
  seenSentences: string[],
  similarityThreshold = 0.84,
  maxSentences = Number.POSITIVE_INFINITY
): string[] {
  const novel: string[] = [];

  for (const sentence of candidates) {
    if (seenSentences.some((existing) => calculateTextSimilarity(existing, sentence) >= similarityThreshold)) {
      continue;
    }

    if (novel.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
      continue;
    }

    novel.push(sentence);
    if (novel.length >= maxSentences) {
      break;
    }
  }

  return novel;
}

function buildFallbackChapterContent(
  page: WebPageGenotype,
  seenSentences: string[]
): { content: string; novelSentences: string[] } {
  const pageSentences = dedupeSentences(page.content, 4);
  const novelSentences = filterNovelSentences(pageSentences, seenSentences, 0.84, 4);

  if (novelSentences.length > 0) {
    return {
      content: novelSentences.join(' '),
      novelSentences,
    };
  }

  const sanitizedContent = sanitizeFallbackSnippet(page.content);
  if (
    sanitizedContent &&
    !seenSentences.some((existing) => calculateTextSimilarity(existing, sanitizedContent) >= 0.84)
  ) {
    return {
      content: sanitizedContent,
      novelSentences: [sanitizedContent],
    };
  }

  return {
    content: '',
    novelSentences: [],
  };
}

function buildFallbackTitleSynthesis(topic: string, results: SearchFallbackResult[]): string {
  const focusAreas: string[] = [];

  for (const result of results) {
    const label = deriveConceptLabel(result.title, topic);
    if (!label) {
      continue;
    }

    if (focusAreas.some((existing) => calculateTextSimilarity(existing, label) >= 0.72)) {
      continue;
    }

    focusAreas.push(label);
    if (focusAreas.length >= 3) {
      break;
    }
  }

  if (focusAreas.length === 0) {
    return `Live search coverage for ${topic} was assembled from multiple external sources.`;
  }

  if (focusAreas.length === 1) {
    return `Live search coverage for ${topic} centers on ${focusAreas[0]}.`;
  }

  if (focusAreas.length === 2) {
    return `Live search coverage for ${topic} connects ${focusAreas[0]} and ${focusAreas[1]}.`;
  }

  return `Live search coverage for ${topic} connects ${focusAreas[0]}, ${focusAreas[1]}, and ${focusAreas[2]}.`;
}

function buildFallbackSynthesisSummary(
  summary: string,
  chapterPages: WebPageGenotype[],
  topic: string,
  results: SearchFallbackResult[]
): string {
  const chapterSentences = dedupeSentences(
    chapterPages.map((page) => page.content).join(' '),
    20
  );
  const novelSummarySentences = filterNovelSentences(dedupeSentences(summary, 4), chapterSentences, 0.84, 3);

  if (novelSummarySentences.length > 0) {
    return novelSummarySentences.join(' ');
  }

  return buildFallbackTitleSynthesis(topic, results);
}

function distinctSourceReferences(sources: Array<{ title: string; url: string }>, maxSources: number): Array<{ title: string; url: string }> {
  const distinct: Array<{ title: string; url: string }> = [];

  for (const source of sources) {
    if (!source.url || distinct.some((existing) => existing.url === source.url)) {
      continue;
    }

    distinct.push(source);
    if (distinct.length >= maxSources) {
      break;
    }
  }

  return distinct;
}

function selectDistinctFallbackPages(
  pages: WebPageGenotype[],
  maxPages = 4
): WebPageGenotype[] {
  const distinct: WebPageGenotype[] = [];
  const seenSentences: string[] = [];

  for (const page of pages) {
    if (!page.content?.trim()) {
      continue;
    }

    const { content: pageBody, novelSentences } = buildFallbackChapterContent(page, seenSentences);
    if (!pageBody) {
      continue;
    }

    const isDuplicate = distinct.some((existing) => {
      const titleSimilarity = calculateTextSimilarity(existing.title, page.title);
      const bodySimilarity = calculateTextSimilarity(existing.content, pageBody);

      return titleSimilarity >= 0.74 || bodySimilarity >= 0.76;
    });

    if (isDuplicate) {
      continue;
    }

    distinct.push({
      ...page,
      content: pageBody,
    });
    seenSentences.push(...novelSentences);

    if (distinct.length >= maxPages) {
      break;
    }
  }

  return distinct;
}

function createFallbackWebBook(
  optimalPopulation: WebPageGenotype[],
  topic: string,
  fallbackPayload: SearchFallbackPayload | undefined,
  fallbackSource: SearchFallbackSource | undefined,
  fallbackReason: SearchFallbackReason | undefined,
  generationNote: string | undefined
): WebBook {
  const rawSummary = sanitizeFallbackSnippet(fallbackPayload?.summary || buildSearchSummaryFromPopulation(optimalPopulation, topic));
  const searchUrl = buildSearchUrl(topic);
  const distinctFallbackResults = fallbackPayload ? selectDistinctFallbackResults(fallbackPayload.results) : [];
  const referenceSources = distinctSourceReferences(
    distinctFallbackResults.map((result) => ({ title: result.title, url: result.url })),
    5
  );
  const payloadPages = fallbackPayload ? buildFallbackPopulation({ ...fallbackPayload, results: distinctFallbackResults }).slice(1) : [];
  const populationPages = optimalPopulation.filter((page) => !isSyntheticPage(page) && page.url !== searchUrl);
  const candidatePages = [
    ...payloadPages,
    ...populationPages.filter((page) => !payloadPages.some((payloadPage) => payloadPage.url === page.url)),
  ];
  const chapterPages = selectDistinctFallbackPages(
    candidatePages,
    4
  );
  const uncoveredResults = distinctFallbackResults.filter(
    (result) => !chapterPages.some((page) => page.url === result.url)
  );
  const summary = buildFallbackSynthesisSummary(
    rawSummary,
    chapterPages,
    topic,
    uncoveredResults.length > 0 ? uncoveredResults : distinctFallbackResults
  );

  const synthesisChapter = {
    title: fallbackPayload?.source === 'google-ai-overview' ? 'Google Search AI Overview' : 'Google Search Synthesis',
    content: summary,
    definitions: getRenderableDefinitions([
      {
        term: topic,
        description: summary,
        sourceUrl: searchUrl,
      },
      ...uncoveredResults.slice(0, 3).map((result) => ({
        term: deriveConceptLabel(result.title, topic),
        description: result.snippet,
        sourceUrl: result.url,
      })),
    ], 6),
    subTopics: getRenderableSubTopics([
      ...uncoveredResults.slice(0, 4).map((result) => ({
        title: result.title,
        summary: result.snippet,
        sourceUrl: result.url,
      })),
    ]).slice(0, 6),
    sourceUrls: distinctSourceReferences([...referenceSources, { title: 'Google Search', url: searchUrl }], 5),
    visualSeed: topic,
  };

  const chapters = chapterPages
    .map((page) => ({
      title: page.title,
      content: page.content,
      definitions: getRenderableDefinitions(page.definitions || [], 4),
      subTopics: getRenderableSubTopics(page.subTopics || []).slice(0, 4),
      sourceUrls: distinctSourceReferences(
        [{ title: page.title, url: page.url }, ...referenceSources.filter((source) => source.url !== page.url)],
        3
      ),
      visualSeed: deriveConceptLabel(page.title, topic),
    }))
    .filter((chapter) => chapter.content && chapter.content.trim().length > 0);

  return {
    topic,
    chapters: [synthesisChapter, ...chapters],
    id: `book-${Date.now()}`,
    timestamp: Date.now(),
    sourceMode: 'search-fallback',
    generationNote,
    fallbackSource,
    fallbackReason,
  };
}

function applyBookMetadata(book: WebBook, context?: Partial<SearchAndExtractResult>): WebBook {
  return {
    ...book,
    sourceMode: context?.sourceMode || book.sourceMode,
    generationNote: context?.generationNote || book.generationNote,
    fallbackSource: context?.fallbackSource || book.fallbackSource,
    fallbackReason: context?.fallbackReason || book.fallbackReason,
  };
}

export async function assembleWebBook(
  optimalPopulation: WebPageGenotype[],
  topic: string,
  context?: SearchAndExtractResult
): Promise<WebBook> {
  if (context?.sourceMode === 'search-fallback') {
    return createFallbackWebBook(
      optimalPopulation,
      topic,
      context.fallbackPayload,
      context.fallbackSource,
      context.fallbackReason,
      context.generationNote
    );
  }

  try {
    const book = await assembleWebBookWithGemini(optimalPopulation, topic);
    return applyBookMetadata(book, context);
  } catch (error) {
    const fallbackReason = classifyGeminiError(error);
    if (!fallbackReason) {
      throw error;
    }

    let fallbackPayload = context?.fallbackPayload;
    if (!fallbackPayload) {
      try {
        fallbackPayload = await fetchGoogleSearchFallback(topic);
      } catch (fallbackError) {
        console.error('Failed to fetch Google Search fallback during assembly', fallbackError);
      }
    }

    const fallbackSource = fallbackPayload?.source || context?.fallbackSource || 'google-search-snippets';
    const generationNote = buildFallbackNotice(fallbackReason, fallbackSource, fallbackPayload?.provider || 'google');

    return createFallbackWebBook(
      optimalPopulation,
      topic,
      fallbackPayload,
      fallbackSource,
      fallbackReason,
      generationNote
    );
  }
}
