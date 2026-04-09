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
export const CONSOLIDATED_SOURCE_POOL_SIZE = 48;
export const ASSEMBLY_SOURCE_POOL_SIZE = 18;
export const FINAL_WEBBOOK_CHAPTER_COUNT = 10;
const CHAPTER_SOURCE_CONTEXT_SIZE = 6;
const MAX_SOURCES_PER_DOMAIN = 2;
const MIN_CHAPTER_WORD_COUNT = 900;
const FALLBACK_MIN_CHAPTER_WORD_COUNT = 300;
const FALLBACK_TARGET_PARAGRAPH_COUNT = 3;
const FALLBACK_MIN_SENTENCE_POOL = 6;
const FALLBACK_MAX_SENTENCE_POOL = 12;
const MIN_USABLE_SOURCE_WORD_COUNT = 35;
const MIN_USABLE_SEARCH_SOURCE_COUNT = 1;
const GEMINI_RECONNECT_ATTEMPTS = 5;
const GEMINI_RETRY_INITIAL_DELAY_MS = 2000;
const GEMINI_REQUEST_TIMEOUT_MS = 30000;
const GEMINI_MISSING_KEY_PATTERNS = [
  /\bgemini[_\s-]*api[_\s-]*key[_\s-]*missing\b/i,
  /\bapi[_\s-]*key[_\s-]*missing\b/i,
  /\bmissing\b.{0,40}\b(?:gemini|api)\b.{0,40}\bkey\b/i,
];
const GEMINI_INVALID_KEY_PATTERNS = [
  /\bapi[_\s-]*key[_\s-]*invalid\b/i,
  /\binvalid[_\s-]*api[_\s-]*key\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\baccess denied\b/i,
  /\bpermission denied\b/i,
  /\brejected\b.{0,40}\b(?:api|access|credential|key)\b/i,
];
const GEMINI_RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /\bquota\b/i,
  /\brate[\s-]*limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\bresource[_\s-]*exhausted\b/i,
];
const GEMINI_NETWORK_PATTERNS = [
  /\bfailed to call(?:\s+the)?\s+gemini(?:\s+api)?\b/i,
  /\b(?:unable|failed|could not|can't|cannot)\b.{0,50}\b(?:call|reach|connect|contact|fetch)\b.{0,50}\bgemini(?:\s+api)?\b/i,
  /\bgemini(?:\s+api)?\b.{0,50}\b(?:not reachable|unreachable|temporarily unreachable|not available|unavailable)\b/i,
  /\bgemini(?:\s+api)?\b.{0,50}\bplease try again\b/i,
  /\bfailed to fetch\b/i,
  /\bfetch failed\b/i,
  /\bnetwork\s*error\b/i,
  /\bnetwork request failed\b/i,
  /\bconnection(?: reset| refused| timed out)?\b/i,
  /\b(?:timed?\s*out|timeout)\b/i,
  /\bsocket hang up\b/i,
  /\bdns\b/i,
  /\b(?:econnreset|econnrefused|enotfound|eai_again|etimedout)\b/i,
];
const GEMINI_SERVICE_PATTERNS = [
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\binternal(?: server)? error\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\btemporar(?:y|ily) unavailable\b/i,
];
const GEMINI_INCOMPLETE_OUTPUT_PATTERNS = [
  /\bgemini\b.{0,50}\b(?:returned|produced|generated|assembled)\b.{0,50}\b(?:no|zero|empty)\b.{0,50}\b(?:renderable\s+)?chapters?\b/i,
  /\bgemini\b.{0,50}\b(?:web[-\s]?book|chapter set|assembly)\b.{0,50}\b(?:empty|incomplete)\b/i,
];
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
const FALLBACK_NARRATIVE_META_PATTERNS = [
  /\bfallback\b/i,
  /\brender(?:er|ing)?\b/i,
  /\bglossary page\b/i,
  /\btechnical glossary\b/i,
  /\bsearch snippet(?:s)?\b/i,
  /\blive search coverage\b/i,
  /\bweb-book\b/i,
  /\bgemini-assisted synthesis\b/i,
  /\blive model synthesis\b/i,
  /\bsource-aware reading\b/i,
  /\bvisible evidence trail\b/i,
  /\bone-line abstract\b/i,
  /\bsetup,\s*to supporting detail,\s*to synthesis\b/i,
  /\barticle pages?\b/i,
  /\bnarrative pages?\b/i,
  /\bsynthesis layer\b/i,
  /^\s*coverage from\b/i,
  /^\s*across these sources\b/i,
  /^\s*taken together\b/i,
  /^\s*a comparative view\b/i,
  /^\s*this range of reporting\b/i,
  /^\s*read together\b/i,
  /^\s*additional reporting\b/i,
  /^\s*this broader mix of evidence\b/i,
  /^\s*a related thread from\b/i,
  /^\s*placed beside one another\b/i,
  /^\s*viewed in the wider context\b/i,
  /^\s*seen as a sequence\b/i,
  /^\s*the subject therefore extends beyond\b/i,
  /^\s*material from\b/i,
];

function resolveGeminiApiKey(): string | undefined {
  const globalScope = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>;
    };
    __APP_ENV__?: Record<string, string | undefined>;
    GEMINI_API_KEY?: string;
  };

  return (
    import.meta.env.VITE_GEMINI_API_KEY ||
    globalScope.__APP_ENV__?.GEMINI_API_KEY ||
    globalScope.GEMINI_API_KEY ||
    globalScope.process?.env?.GEMINI_API_KEY
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesAnyPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function containsFallbackNarrativeMeta(text: string): boolean {
  return matchesAnyPattern(text, FALLBACK_NARRATIVE_META_PATTERNS);
}

function filterReaderFacingFallbackSentences(sentences: string[]): string[] {
  const filtered: string[] = [];

  for (const sentence of sentences) {
    const normalized = sentence.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      continue;
    }

    if (containsFallbackNarrativeMeta(normalized)) {
      continue;
    }

    const domainMentions = normalized.match(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|wiki|io|co(?:\.[a-z]{2})?)\b/gi) || [];
    if (domainMentions.length >= 2) {
      continue;
    }

    if (filtered.some((existing) => calculateTextSimilarity(existing, normalized) >= 0.88)) {
      continue;
    }

    filtered.push(normalized);
  }

  return filtered;
}

function buildFallbackParagraphsFromSentences(sentences: string[], paragraphCount: number): string[] {
  if (sentences.length === 0) {
    return [];
  }

  const paragraphs: string[] = [];
  const sentencesPerParagraph = Math.max(2, Math.ceil(sentences.length / paragraphCount));

  for (let index = 0; index < sentences.length; index += sentencesPerParagraph) {
    const chunk = sentences.slice(index, index + sentencesPerParagraph);
    if (chunk.length === 0) {
      continue;
    }

    paragraphs.push(chunk.join(' '));
  }

  return paragraphs;
}

function pruneFallbackNarrativeContent(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const cleanedParagraphs = paragraphs
    .map((paragraph) => filterReaderFacingFallbackSentences(collectDistinctSentences([paragraph], FALLBACK_MAX_SENTENCE_POOL)).join(' '))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return cleanedParagraphs.join('\n\n').trim();
}

function formatGeminiError(error: unknown): string {
  const errorObject = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
  const segments = [
    typeof error === 'string' ? error : '',
    String(errorObject?.message || ''),
    String(errorObject?.statusText || ''),
    String(errorObject?.name || ''),
    String(errorObject?.code || ''),
    String(errorObject?.status || ''),
    typeof error === 'string' ? '' : JSON.stringify(errorObject || {}),
  ]
    .map((segment) => segment.trim())
    .filter(Boolean);

  const uniqueSegments = Array.from(new Set(segments));
  return uniqueSegments.length > 0 ? uniqueSegments.join(' | ') : 'Unknown Gemini API error';
}

function isGeminiRetryableError(error: unknown): boolean {
  const errorMessage = formatGeminiError(error);
  const status = (error as any)?.status;
  const code = (error as any)?.code;

  return (
    matchesAnyPattern(errorMessage, GEMINI_NETWORK_PATTERNS) ||
    matchesAnyPattern(errorMessage, GEMINI_SERVICE_PATTERNS) ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 408 ||
    code === 500 ||
    code === 502 ||
    code === 503 ||
    code === 504
  );
}

async function withTimeout<T>(promiseFactory: () => Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promiseFactory()
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

const getAI = () => {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY_MISSING');
  }
  return new GoogleGenAI({ apiKey });
};

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = GEMINI_RECONNECT_ATTEMPTS,
  delay = GEMINI_RETRY_INITIAL_DELAY_MS,
  label = 'Gemini API'
): Promise<T> {
  try {
    return await withTimeout(fn, GEMINI_REQUEST_TIMEOUT_MS, label);
  } catch (error: any) {
    const errorMessage = formatGeminiError(error);

    if (attempts > 1 && isGeminiRetryableError(error)) {
      console.warn(
        `${label} attempt failed (${GEMINI_RECONNECT_ATTEMPTS - attempts + 1}/${GEMINI_RECONNECT_ATTEMPTS}): ${errorMessage.substring(0, 200)}`
      );
      await wait(delay);
      const nextDelay = delay * 2 + Math.random() * 1000;
      return withRetry(fn, attempts - 1, nextDelay, label);
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
  const message = formatGeminiError(error);

  const status = (error as any)?.status;

  if (matchesAnyPattern(message, GEMINI_MISSING_KEY_PATTERNS)) {
    return 'missing_api_key';
  }
  if (matchesAnyPattern(message, GEMINI_INVALID_KEY_PATTERNS) || status === 401 || status === 403) {
    return 'invalid_api_key';
  }
  if (matchesAnyPattern(message, GEMINI_RATE_LIMIT_PATTERNS) || status === 429) {
    return 'quota_or_rate_limit';
  }
  if (matchesAnyPattern(message, GEMINI_NETWORK_PATTERNS) || status === 408 || status === 504) {
    return 'network_unreachable';
  }
  if (matchesAnyPattern(message, GEMINI_SERVICE_PATTERNS) || status === 500 || status === 502 || status === 503) {
    return 'service_unavailable';
  }
  if (/\bgemini(?:\s+api)?\b/i.test(message)) {
    return 'network_unreachable';
  }
  return null;
}

function isGeminiOutputIncomplete(error: unknown): boolean {
  return matchesAnyPattern(formatGeminiError(error), GEMINI_INCOMPLETE_OUTPUT_PATTERNS);
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
    network_unreachable: `Gemini API was unreachable after ${GEMINI_RECONNECT_ATTEMPTS} reconnection attempts`,
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

function getDuckDuckGoFallbackResultCount(payload?: SearchFallbackPayload): number {
  if (!payload) {
    return 0;
  }

  const diagnostic = payload.diagnostics?.find((entry) => entry.startsWith('duckduckgo-results:'));
  if (!diagnostic) {
    return payload.provider === 'duckduckgo' ? payload.results.length : 0;
  }

  const count = Number.parseInt(diagnostic.split(':')[1] || '0', 10);
  return Number.isFinite(count) ? count : 0;
}

function hasDuckDuckGoFallbackEvidence(payload?: SearchFallbackPayload): boolean {
  return getDuckDuckGoFallbackResultCount(payload) > 0;
}

function buildFallbackOverviewTitle(payload: SearchFallbackPayload): string {
  if (payload.source === 'google-ai-overview') {
    return hasDuckDuckGoFallbackEvidence(payload)
      ? `${payload.query} - Google AI Overview + DuckDuckGo Cross-Check`
      : `${payload.query} - Google AI Overview`;
  }

  return hasDuckDuckGoFallbackEvidence(payload)
    ? `${payload.query} - Google + DuckDuckGo Search Summary`
    : `${payload.query} - Google Search Summary`;
}

function buildFallbackNoticeFromPayload(
  reason: SearchFallbackReason,
  payload: SearchFallbackPayload
): string {
  const baseNotice = buildFallbackNotice(reason, payload.source, payload.provider);
  return hasDuckDuckGoFallbackEvidence(payload)
    ? `${baseNotice} DuckDuckGo alternate search results were also blended into the fallback evidence set.`
    : baseNotice;
}

function buildSearchUrl(query: string): string {
  return `${FALLBACK_SOURCE_URL}?q=${encodeURIComponent(query)}`;
}

async function safeFetchSearchFallback(query: string, label: string): Promise<SearchFallbackPayload | undefined> {
  try {
    return await fetchGoogleSearchFallback(query);
  } catch (error) {
    console.error(`${label} fallback search fetch failed`, error);
    return undefined;
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function hasRenderableChapters(chapters: WebBook['chapters']): boolean {
  if (!Array.isArray(chapters)) {
    return false;
  }

  return chapters.some((chapter) => {
    const content = normalizePopulationText(chapter?.content || '');
    return content.length > 0 && countWords(content) >= 80 && isMeaningfulText(content);
  });
}

function buildIncompleteGeminiFallbackNotice(hasLiveFallback: boolean): string {
  if (hasLiveFallback) {
    return 'Gemini returned an incomplete chapter set, so the Web-book was rebuilt from the available evidence and fallback search results.';
  }

  return 'Gemini returned an incomplete chapter set, so the Web-book was rebuilt from the current evidence pool only.';
}

function buildEmptySearchEvidenceNotice(query: string): Error {
  return new Error(
    `Gemini search returned no usable external sources for "${query}", and live fallback search could not be reached. ` +
    'The app needs either Gemini search evidence or the /api/search-fallback route to continue.'
  );
}

function buildUnavailableFallbackSearchError(query: string, reason: SearchFallbackReason): Error {
  return new Error(
    `${{
      missing_api_key: 'Gemini API key is missing',
      invalid_api_key: 'Gemini API key is invalid or rejected',
      quota_or_rate_limit: 'Gemini API quota or rate limit was reached',
      service_unavailable: 'Gemini API is temporarily unavailable',
      network_unreachable: `Gemini API was unreachable after ${GEMINI_RECONNECT_ATTEMPTS} reconnection attempts`,
    }[reason]}; live fallback search (Google + DuckDuckGo) was unavailable, so no external evidence could be gathered for "${query}".`
  );
}

function buildGeminiCoverageFallbackNotice(payload: SearchFallbackPayload, sourceCount: number): string {
  const evidenceText = hasDuckDuckGoFallbackEvidence(payload)
    ? 'Google Search and DuckDuckGo fallback evidence'
    : payload.source === 'google-ai-overview'
      ? 'Google Search AI Overview evidence'
      : 'live Google Search evidence';

  return `Gemini search returned too little usable external coverage, so the engine switched to ${evidenceText} and consolidated ${sourceCount} sources before evolution.`;
}

function getSourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url === 'hybrid-source' ? 'synthetic-source' : 'unknown-source';
  }
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

function scorePopulationCandidate(page: WebPageGenotype): number {
  return (
    (Number.isFinite(page.fitness) ? page.fitness * 0.55 : 0) +
    (Number.isFinite(page.informativeScore) ? page.informativeScore : 0) +
    (Number.isFinite(page.authorityScore) ? page.authorityScore : 0) +
    Math.min(countWords(page.content || '') / 900, 0.18) +
    Math.min((page.definitions || []).length / 10, 0.08) +
    Math.min((page.subTopics || []).length / 10, 0.08)
  );
}

function scoreFallbackResultCandidate(result: SearchFallbackResult): number {
  const evidenceText = buildFallbackResultEvidenceText(result);
  return (
    scoreDomainAuthority(result.url) +
    scoreInformativeText(evidenceText) +
    Math.min(countWords(evidenceText) / 220, 0.16)
  );
}

function balanceItemsByDomain<T>(
  items: T[],
  options: {
    maxItems: number;
    getDomain: (item: T) => string;
    getScore: (item: T) => number;
    maxPerDomain?: number;
    preferredFirstPassPerDomain?: number;
  }
): T[] {
  const {
    maxItems,
    getDomain,
    getScore,
    maxPerDomain = MAX_SOURCES_PER_DOMAIN,
    preferredFirstPassPerDomain = 1,
  } = options;

  const sorted = [...items].sort((left, right) => getScore(right) - getScore(left));
  const selected: T[] = [];
  const selectedSet = new Set<T>();
  const perDomainCounts = new Map<string, number>();

  const trySelect = (item: T, domainCap: number) => {
    if (selected.length >= maxItems || selectedSet.has(item)) {
      return;
    }

    const domain = getDomain(item);
    const currentCount = perDomainCounts.get(domain) || 0;
    if (currentCount >= domainCap) {
      return;
    }

    selected.push(item);
    selectedSet.add(item);
    perDomainCounts.set(domain, currentCount + 1);
  };

  const passCaps = Array.from(new Set([
    Math.max(1, Math.min(preferredFirstPassPerDomain, maxPerDomain)),
    Math.max(1, maxPerDomain),
  ]));

  for (const domainCap of passCaps) {
    for (const item of sorted) {
      trySelect(item, domainCap);
    }
  }

  if (selected.length < maxItems) {
    for (const item of sorted) {
      if (selectedSet.has(item)) {
        continue;
      }

      selected.push(item);
      selectedSet.add(item);
      if (selected.length >= maxItems) {
        break;
      }
    }
  }

  return selected.slice(0, maxItems);
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

function sanitizeFallbackSnippet(text: string, maxSentences = 4): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\.\.\.\s*(?=[A-Z])/g, ' ')
    .trim();

  const uniqueSentences = dedupeSentences(cleaned, maxSentences);
  if (uniqueSentences.length > 0) {
    return uniqueSentences.join(' ');
  }

  return cleaned;
}

function buildFallbackResultEvidenceText(result: SearchFallbackResult): string {
  return normalizePopulationText([
    result.excerpt || '',
    result.snippet || '',
  ].join(' '));
}

function selectDistinctFallbackResults(results: SearchFallbackResult[], maxResults = 5): SearchFallbackResult[] {
  const distinct: SearchFallbackResult[] = [];

  for (const result of results) {
    const candidate: SearchFallbackResult = {
      ...result,
      title: result.title.trim(),
      snippet: sanitizeFallbackSnippet(result.snippet, 4),
      excerpt: result.excerpt ? sanitizeFallbackSnippet(result.excerpt, 10) : undefined,
    };

    if (!candidate.title || !candidate.snippet) {
      continue;
    }

    const candidateEvidenceText = buildFallbackResultEvidenceText(candidate);

    const isDuplicate = distinct.some((existing) => {
      if (existing.url === candidate.url) {
        return true;
      }

      const titleSimilarity = calculateTextSimilarity(existing.title, candidate.title);
      const snippetSimilarity = calculateTextSimilarity(existing.snippet, candidate.snippet);
      const evidenceSimilarity = calculateTextSimilarity(
        buildFallbackResultEvidenceText(existing),
        candidateEvidenceText
      );
      return titleSimilarity >= 0.78
        || (titleSimilarity >= 0.58 && snippetSimilarity >= 0.72)
        || snippetSimilarity >= 0.9
        || evidenceSimilarity >= 0.9;
    });

    if (isDuplicate) {
      continue;
    }

    distinct.push(candidate);
  }

  return balanceItemsByDomain(distinct, {
    maxItems: maxResults,
    getDomain: (result) => getSourceDomain(result.url),
    getScore: scoreFallbackResultCandidate,
  });
}

function isSyntheticPage(page: WebPageGenotype): boolean {
  return page.url === 'hybrid-source' || page.title.toLowerCase().startsWith('synthesized:');
}

function getUsableExternalEvidencePages(pages: WebPageGenotype[]): WebPageGenotype[] {
  return selectDistinctPopulationPages(Array.isArray(pages) ? pages : [], CONSOLIDATED_SOURCE_POOL_SIZE)
    .filter((page) => {
      const content = normalizePopulationText(page.content || '');
      return /^https?:\/\//i.test(page.url || '')
        && !isSyntheticPage(page)
        && countWords(content) >= MIN_USABLE_SOURCE_WORD_COUNT
        && isMeaningfulText(content);
    });
}

function hasUsableSearchEvidence(pages: WebPageGenotype[]): boolean {
  return getUsableExternalEvidencePages(pages).length >= MIN_USABLE_SEARCH_SOURCE_COUNT;
}

function hasUsableFallbackPayload(payload?: SearchFallbackPayload): boolean {
  if (!payload) {
    return false;
  }

  return selectDistinctFallbackResults(payload.results, CONSOLIDATED_SOURCE_POOL_SIZE).length > 0;
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

  return `Available external reporting on ${topic} was limited, but the sources that were available still pointed to several recurring themes.`;
}

function normalizePopulationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function selectDistinctPopulationPages(
  pages: WebPageGenotype[],
  maxPages = CONSOLIDATED_SOURCE_POOL_SIZE
): WebPageGenotype[] {
  const distinct: WebPageGenotype[] = [];

  for (const page of pages) {
    const candidate: WebPageGenotype = {
      ...page,
      title: page.title?.trim() || '',
      content: normalizePopulationText(page.content || ''),
      definitions: getRenderableDefinitions(page.definitions || [], 8),
      subTopics: getRenderableSubTopics(page.subTopics || []).slice(0, 8),
      informativeScore: Number.isFinite(page.informativeScore) ? page.informativeScore : scoreInformativeText(page.content || ''),
      authorityScore: Number.isFinite(page.authorityScore) ? page.authorityScore : scoreDomainAuthority(page.url),
      fitness: Number.isFinite(page.fitness) ? page.fitness : 0,
    };

    if (!candidate.title || !candidate.content || !candidate.url) {
      continue;
    }

    const isDuplicate = distinct.some((existing) => {
      if (existing.url === candidate.url) {
        return true;
      }

      const titleSimilarity = calculateTextSimilarity(existing.title, candidate.title);
      const contentSimilarity = calculateTextSimilarity(
        existing.content.slice(0, 900),
        candidate.content.slice(0, 900)
      );

      return titleSimilarity >= 0.82
        || (titleSimilarity >= 0.6 && contentSimilarity >= 0.72)
        || contentSimilarity >= 0.9;
    });

    if (isDuplicate) {
      continue;
    }

    distinct.push(candidate);
  }

  return balanceItemsByDomain(distinct, {
    maxItems: maxPages,
    getDomain: (page) => getSourceDomain(page.url),
    getScore: scorePopulationCandidate,
  });
}

function mergeSearchArtifacts(primary: SearchArtifact[], supplemental: SearchArtifact[]): SearchArtifact[] {
  const merged: SearchArtifact[] = [];
  const seenKeys = new Set<string>();

  for (const artifact of [...primary, ...supplemental]) {
    const key = artifact.web?.uri
      || `${artifact.web?.title || 'untitled'}|${artifact.snippet?.slice(0, 160) || ''}`;

    if (!key || seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    merged.push(artifact);

    if (merged.length >= CONSOLIDATED_SOURCE_POOL_SIZE) {
      break;
    }
  }

  return merged;
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
  const distinctResults = selectDistinctFallbackResults(payload.results, CONSOLIDATED_SOURCE_POOL_SIZE - 1);
  const overviewDefinitions = getRenderableDefinitions([
    {
      term: payload.query,
      description: payload.summary,
      sourceUrl: searchUrl,
    },
    ...distinctResults.slice(0, 6).map((result) => ({
      term: deriveConceptLabel(result.title, payload.query),
      description: result.snippet,
      sourceUrl: result.url,
    })),
  ], 8);

  const overviewSubTopics = getRenderableSubTopics(
    distinctResults.slice(0, 8).map((result) => ({
      title: result.title,
      summary: result.snippet,
      sourceUrl: result.url,
    }))
  ).slice(0, 8);

  const overviewPage: WebPageGenotype = {
    id: `fallback-overview-${payload.extractedAt}`,
    url: searchUrl,
    title: buildFallbackOverviewTitle(payload),
    content: sanitizeFallbackSnippet(payload.summary),
    definitions: overviewDefinitions,
    subTopics: overviewSubTopics,
    informativeScore: scoreInformativeText(payload.summary),
    authorityScore: 0.82,
    fitness: 0,
  };

  const sourcePages = distinctResults.slice(0, CONSOLIDATED_SOURCE_POOL_SIZE - 1).map((result, index) => {
    const resultEvidenceText = buildFallbackResultEvidenceText(result);
    const referenceDescription = sanitizeFallbackSnippet(resultEvidenceText || result.snippet, 6);

    return {
      id: `fallback-source-${index}-${payload.extractedAt}`,
      url: result.url,
      title: result.title,
      content: resultEvidenceText,
      definitions: getRenderableDefinitions([
        {
          term: deriveConceptLabel(result.title, payload.query),
          description: referenceDescription,
          sourceUrl: result.url,
        },
      ]),
      subTopics: getRenderableSubTopics([
        {
          title: result.title,
          summary: sanitizeFallbackSnippet(result.excerpt || result.snippet, 4),
          sourceUrl: result.url,
        },
      ]),
      informativeScore: scoreInformativeText(resultEvidenceText),
      authorityScore: scoreDomainAuthority(result.url),
      fitness: 0,
    };
  });

  return [overviewPage, ...sourcePages];
}

async function enrichGeminiSearchResult(query: string, geminiResult: SearchAndExtractResult): Promise<SearchAndExtractResult> {
  const distinctGeminiResults = selectDistinctPopulationPages(geminiResult.results, CONSOLIDATED_SOURCE_POOL_SIZE);
  const geminiHasUsableEvidence = hasUsableSearchEvidence(distinctGeminiResults);

  try {
    const fallbackPayload = await fetchGoogleSearchFallback(query);
    const fallbackPopulation = buildFallbackPopulation(fallbackPayload);
    const enrichedResults = selectDistinctPopulationPages(
      [...distinctGeminiResults, ...fallbackPopulation],
      CONSOLIDATED_SOURCE_POOL_SIZE
    );
    const fallbackHasUsableEvidence = hasUsableFallbackPayload(fallbackPayload);

    if (!geminiHasUsableEvidence && fallbackHasUsableEvidence) {
      return {
        results: enrichedResults,
        artifacts: {
          groundingChunks: mergeSearchArtifacts(geminiResult.artifacts.groundingChunks, mapFallbackArtifacts(fallbackPayload)),
          searchSummary: fallbackPayload.summary,
        },
        sourceMode: 'search-fallback',
        generationNote: buildGeminiCoverageFallbackNotice(fallbackPayload, enrichedResults.length),
        fallbackSource: fallbackPayload.source,
        fallbackPayload,
      };
    }

    if (!geminiHasUsableEvidence && !fallbackHasUsableEvidence) {
      throw buildEmptySearchEvidenceNotice(query);
    }

    return {
      ...geminiResult,
      results: enrichedResults,
      artifacts: {
        groundingChunks: mergeSearchArtifacts(geminiResult.artifacts.groundingChunks, mapFallbackArtifacts(fallbackPayload)),
        searchSummary: fallbackPayload.summary,
      },
      generationNote: enrichedResults.length > distinctGeminiResults.length
        ? `Gemini extraction was enriched with live search evidence, consolidating ${enrichedResults.length} sources before evolution.`
        : geminiResult.generationNote,
      fallbackPayload,
    };
  } catch (error) {
    console.warn('Gemini enrichment with live search evidence was unavailable', error);
    if (!geminiHasUsableEvidence) {
      throw buildEmptySearchEvidenceNotice(query);
    }
    return {
      ...geminiResult,
      results: distinctGeminiResults,
    };
  }
}

async function searchAndExtractWithGemini(query: string): Promise<SearchAndExtractResult> {
  const ai = getAI();

  const response = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Search for comprehensive information about "${query}".
    Identify 16-24 distinct high-quality web pages or sources that collectively cover the topic from foundational, practical, historical, policy, comparative, and advanced perspectives.
    Diversify the evidence base across multiple credible domains. Avoid over-concentrating on one publisher or hostname, cap any single domain at two results unless the topic genuinely requires more, and prefer a plural mix of academic, government, nonprofit, standards, industry, and reputable journalism sources when relevant.
    For each source, extract:
    1. A list of key definitions found on the page.
    2. A list of salient sub-topics discussed.
    3. A summary of the content.
    4. An assessment of its "Informative Value" (0-1) based on depth of definitions.
    5. An assessment of its "Authority" (0-1) based on source credibility.`,
    config: {
      systemInstruction: 'You are a precise data extractor. Extract only real, meaningful definitions and sub-topics from the search results. Do not generate placeholder text, random numbers, or gibberish. Favor plural, credible, domain-diverse sources and avoid near-duplicate pages from the same publisher unless they add unique evidence. If no meaningful definitions are found for a source, return an empty array for that source\'s definitions.',
      tools: [{ googleSearch: {} }],
      responseMimeType: 'application/json',
      maxOutputTokens: 14000,
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
  }), GEMINI_RECONNECT_ATTEMPTS, GEMINI_RETRY_INITIAL_DELAY_MS, 'Gemini search extraction');

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

  const processedResults = selectDistinctPopulationPages(results.map((result: any, index: number) => ({
    ...result,
    id: `gen-${index}-${Date.now()}`,
    content: result.content ? String(result.content).substring(0, 1600) : '',
    definitions: getRenderableDefinitions(
      (result.definitions || []).map((definition: any) => ({ ...definition, sourceUrl: result.url })),
      8
    ),
    subTopics: getRenderableSubTopics(
      (result.subTopics || []).map((subTopic: any) => ({ ...subTopic, sourceUrl: result.url }))
    ).slice(0, 8),
    fitness: 0,
  })), CONSOLIDATED_SOURCE_POOL_SIZE);

  return {
    results: processedResults,
    artifacts: { groundingChunks: rawGroundingChunks },
    sourceMode: 'gemini',
  };
}

export async function searchAndExtract(query: string): Promise<SearchAndExtractResult> {
  try {
    const geminiResult = await searchAndExtractWithGemini(query);
    return await enrichGeminiSearchResult(query, geminiResult);
  } catch (error) {
    const fallbackReason = classifyGeminiError(error);
    if (!fallbackReason) {
      throw error;
    }

    const fallbackPayload = await safeFetchSearchFallback(query, 'Gemini search recovery');
    if (fallbackPayload) {
      return {
        results: buildFallbackPopulation(fallbackPayload),
        artifacts: {
          groundingChunks: mapFallbackArtifacts(fallbackPayload),
          searchSummary: fallbackPayload.summary,
        },
        sourceMode: 'search-fallback',
        generationNote: buildFallbackNoticeFromPayload(fallbackReason, fallbackPayload),
        fallbackSource: fallbackPayload.source,
        fallbackReason,
        fallbackPayload,
      };
    }

    throw buildUnavailableFallbackSearchError(query, fallbackReason);
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
  let currentPopulation = selectDistinctPopulationPages(population, CONSOLIDATED_SOURCE_POOL_SIZE);
  const targetPopulationSize = currentPopulation.length;

  if (targetPopulationSize <= 2) {
    return currentPopulation;
  }

  for (let generation = 0; generation < generations; generation += 1) {
    currentPopulation.forEach((page) => {
      page.fitness = calculateFitness(page, [], EVOLUTION_WEIGHTS);
    });

    currentPopulation.sort((left, right) => right.fitness - left.fitness);
    const survivors = currentPopulation.slice(0, Math.max(2, Math.ceil(targetPopulationSize / 2)));

    const nextPopulation = survivors.map((page) => ({ ...page }));
    let offspringIndex = 0;

    while (nextPopulation.length < targetPopulationSize && survivors.length > 0) {
      const parentA = survivors[offspringIndex % survivors.length];
      const parentB = survivors[(offspringIndex + generation + 1) % survivors.length] || parentA;
      const mergedDefinitions = getRenderableDefinitions([
        ...(parentA.definitions || []).slice(0, 4),
        ...(parentB.definitions || []).slice(0, 4),
      ], 8);
      const mergedSubTopics = getRenderableSubTopics([
        ...(parentA.subTopics || []).slice(0, 4),
        ...(parentB.subTopics || []).slice(0, 4),
      ]).slice(0, 8);
      const hybridContent = dedupeSentences(`${parentA.content} ${parentB.content}`, 8).join(' ')
        || `${parentA.content.substring(0, 500)} ${parentB.content.substring(0, 500)}`.trim();

      nextPopulation.push({
        id: `offspring-${generation}-${offspringIndex}`,
        url: 'hybrid-source',
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: hybridContent,
        definitions: mergedDefinitions,
        subTopics: mergedSubTopics,
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0,
      });

      offspringIndex += 1;
    }

    currentPopulation = nextPopulation.slice(0, targetPopulationSize);
  }

  currentPopulation.forEach((page) => {
    page.fitness = calculateFitness(page, [], EVOLUTION_WEIGHTS);
  });
  currentPopulation.sort((left, right) => right.fitness - left.fitness);

  return currentPopulation;
}

type AssemblySourceContext = {
  title: string;
  url: string;
  content: string;
  definitions: WebPageGenotype['definitions'];
  subTopics: WebPageGenotype['subTopics'];
};

function scoreAssemblySourceRelevance(source: AssemblySourceContext, chapterQuery: string): number {
  const definitionSummary = source.definitions.map((definition) => `${definition.term} ${definition.description}`).join(' ');
  const subTopicSummary = source.subTopics.map((subTopic) => `${subTopic.title} ${subTopic.summary}`).join(' ');

  return (
    (calculateTextSimilarity(source.title, chapterQuery) * 0.45) +
    (calculateTextSimilarity(source.content.slice(0, 900), chapterQuery) * 0.35) +
    (calculateTextSimilarity(`${definitionSummary} ${subTopicSummary}`.slice(0, 900), chapterQuery) * 0.2)
  );
}

function selectBestSupportingSource(queryText: string, sources: AssemblySourceContext[]): AssemblySourceContext | null {
  const rankedSources = sources
    .map((source) => ({
      source,
      score: scoreAssemblySourceRelevance(source, queryText),
    }))
    .sort((left, right) => right.score - left.score);

  return rankedSources[0]?.source || null;
}

function selectRelevantAssemblySources(
  chapterOutline: { title?: string; focus?: string; terms?: string[]; subTopicTitles?: string[] },
  sourcePool: AssemblySourceContext[]
): AssemblySourceContext[] {
  const chapterQuery = [
    chapterOutline.title || '',
    chapterOutline.focus || '',
    ...(chapterOutline.terms || []),
    ...(chapterOutline.subTopicTitles || []),
  ].join(' ');

  const rankedSources = sourcePool.map((source) => ({
    source,
    score: scoreAssemblySourceRelevance(source, chapterQuery),
  }));

  return balanceItemsByDomain(rankedSources, {
    maxItems: CHAPTER_SOURCE_CONTEXT_SIZE,
    getDomain: ({ source }) => getSourceDomain(source.url),
    getScore: ({ score }) => score,
  }).map(({ source }) => source);
}

async function assembleWebBookWithGemini(optimalPopulation: WebPageGenotype[], topic: string): Promise<WebBook> {
  const ai = getAI();
  const assemblySourcePool = selectDistinctPopulationPages([
    ...optimalPopulation.filter((page) => !isSyntheticPage(page)),
    ...optimalPopulation.filter((page) => isSyntheticPage(page)),
  ], ASSEMBLY_SOURCE_POOL_SIZE);
  const truncatedData: AssemblySourceContext[] = assemblySourcePool.map((page) => ({
    title: page.title,
    url: page.url,
    content: page.content.substring(0, 900),
    definitions: page.definitions.slice(0, 4),
    subTopics: page.subTopics.slice(0, 3),
  }));

  const outlineResponse = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: `Topic: ${topic}. Source pool: ${JSON.stringify(truncatedData)}.
    Create a detailed 18-chapter candidate pool for a comprehensive Web-book.
    Every chapter must be supportable by multiple distinct sources from the pool, and the final writing should be substantial enough to fill three narrative pages plus one glossary page.
    For each chapter, provide:
    1. A compelling title.
    2. A brief 2-sentence focus description.
    3. 3 key terms to define.
    4. 2 sub-topics to explore.
    5. A visual seed keyword for an image.
    6. A 'priorityScore' (1-100) representing how essential this chapter is to the core topic.`,
    config: {
      systemInstruction: 'You are a master book architect. Output valid JSON only. Create an 18-chapter candidate pool grounded in the supplied source pool. This is an evolutionary selection process: some chapters will be pruned later based on quality. Ensure a logical flow from basics to advanced. Assign higher priorityScore to foundational and critical chapters. Avoid outline candidates that would lean on only one domain or one narrow perspective. Strictly avoid placeholders or meaningless text.',
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
  }), GEMINI_RECONNECT_ATTEMPTS, GEMINI_RETRY_INITIAL_DELAY_MS, 'Gemini book outline');

  const outlineData = parseJsonResponse<{ topic: string; outline: any[] }>(outlineResponse.text || '', 'The AI could not create a valid book outline.');
  if (!outlineData || !Array.isArray(outlineData.outline)) {
    throw new Error('The AI could not create a valid book outline.');
  }

  const allGeneratedChapters: Array<WebBook['chapters'][number] & { priorityScore: number; originalIndex: number }> = [];
  const concurrencyLimit = 3;

  for (let index = 0; index < outlineData.outline.length; index += concurrencyLimit) {
    const batch = outlineData.outline.slice(index, index + concurrencyLimit);
    const batchResults = await Promise.all(batch.map(async (chapterOutline: any, batchIndex: number) => {
      const relevantSources = selectRelevantAssemblySources(chapterOutline, truncatedData);
      const supportingSources = relevantSources.length > 0
        ? relevantSources
        : truncatedData.slice(0, CHAPTER_SOURCE_CONTEXT_SIZE);
      const chapterResponse = await withRetry(() => ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: `Topic: ${topic}. Chapter: ${chapterOutline.title}. Focus: ${chapterOutline.focus}. Source evidence: ${JSON.stringify(supportingSources)}.
        Write a comprehensive, high-quality long-form chapter of 900-1200 words arranged in 7-9 paragraphs, with enough substance to fill three narrative Web-book pages before the glossary.
        Synthesize at least three distinct source perspectives, noting agreements, tradeoffs, chronology, or practical implications where appropriate.
        Also provide at least 5 detailed definitions, including these terms when relevant: ${chapterOutline.terms.join(', ')}.
        And provide 3-5 detailed analyses for the sub-topics: ${chapterOutline.subTopicTitles.join(', ')}.
        Ground the chapter in the supplied source evidence, synthesizing it into a cohesive explanation rather than copying snippets.`,
        config: {
          systemInstruction: 'You are an expert technical writer. Output valid JSON only. Be detailed, authoritative, and academic in tone. Use only the supplied source evidence, do not invent facts, and explicitly preserve nuance when sources describe limitations or disagreements. Ensure all definitions and sub-topic analyses are meaningful, human-readable, relevant to the chapter, and tied to the strongest supporting source. The prose must feel substantial enough for three narrative pages without padding or repetition. Strictly avoid generating random numbers, long strings of digits, or meaningless placeholder text.',
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
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
      }), GEMINI_RECONNECT_ATTEMPTS, GEMINI_RETRY_INITIAL_DELAY_MS, `Gemini chapter writer: ${chapterOutline.title}`);

      const chapterData = parseJsonResponse<any>(chapterResponse.text || '', 'The AI returned an invalid chapter response.');
      const content = normalizePopulationText(chapterData?.content || '');
      if (!content || !isMeaningfulText(content)) {
        return null;
      }

      const sourceBackedContent = countWords(content) >= MIN_CHAPTER_WORD_COUNT
        ? content
        : `${content}\n\n${filterNovelSentences(
          dedupeSentences(supportingSources.map((source) => source.content).join(' '), 10),
          dedupeSentences(content, 20),
          0.82,
          6
        ).join(' ')}`.trim();

      const filteredDefinitions = getRenderableDefinitions(chapterData?.definitions || [], 8)
        .map((definition: any) => ({
          ...definition,
          sourceUrl: selectBestSupportingSource(`${definition.term} ${definition.description}`, supportingSources)?.url
            || supportingSources[0]?.url
            || 'Synthesized',
        }));
      const filteredSubTopics = getRenderableSubTopics(chapterData?.subTopics || [])
        .slice(0, 6)
        .map((subTopic: any) => ({
          ...subTopic,
          sourceUrl: selectBestSupportingSource(`${subTopic.title} ${subTopic.summary}`, supportingSources)?.url
            || supportingSources[0]?.url
            || 'Synthesized',
        }));

      return {
        title: chapterOutline.title,
        content: sourceBackedContent,
        definitions: filteredDefinitions,
        subTopics: filteredSubTopics,
        sourceUrls: distinctSourceReferences(
          supportingSources.map((data) => ({ title: data.title, url: data.url })),
          CHAPTER_SOURCE_CONTEXT_SIZE
        ),
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
    .slice(0, FINAL_WEBBOOK_CHAPTER_COUNT)
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map(({ priorityScore, originalIndex, ...chapter }) => chapter);

  if (!hasRenderableChapters(selectedChapters)) {
    throw new Error('Gemini returned no renderable chapters for the Web-book.');
  }

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

type FallbackEvidence = {
  title: string;
  url: string;
  content: string;
};

function buildFallbackEvidenceFromPage(page: WebPageGenotype): FallbackEvidence {
  return {
    title: page.title,
    url: page.url,
    content: normalizePopulationText([
      page.content,
      ...(page.definitions || []).map((definition) => definition.description || ''),
      ...(page.subTopics || []).map((subTopic) => subTopic.summary || ''),
    ].join(' ')),
  };
}

function buildFallbackEvidenceFromResult(result: SearchFallbackResult): FallbackEvidence {
  return {
    title: result.title,
    url: result.url,
    content: buildFallbackResultEvidenceText(result),
  };
}

function buildFocusedFallbackChapterSummary(
  topic: string,
  page: WebPageGenotype,
  evidencePool: FallbackEvidence[],
  fallbackSummary: string
): string {
  const focusedSentences = filterReaderFacingFallbackSentences(collectDistinctSentences(
    [
      page.content,
      ...(page.definitions || []).map((definition) => definition.description || ''),
      ...(page.subTopics || []).map((subTopic) => subTopic.summary || ''),
      ...evidencePool.slice(0, 3).map((evidence) => evidence.content),
    ],
    6
  ));

  if (focusedSentences.length > 0) {
    return focusedSentences.slice(0, 2).join(' ');
  }

  return fallbackSummary;
}

function collectDistinctSentences(texts: string[], maxSentences = Number.POSITIVE_INFINITY): string[] {
  const distinct: string[] = [];

  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      if (sentence.length < 35) {
        continue;
      }

      if (distinct.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
        continue;
      }

      distinct.push(sentence);
      if (distinct.length >= maxSentences) {
        return distinct;
      }
    }
  }

  return distinct;
}

function selectRelevantFallbackEvidence(
  seedText: string,
  evidencePool: FallbackEvidence[],
  maxItems = CHAPTER_SOURCE_CONTEXT_SIZE
): FallbackEvidence[] {
  const uniqueEvidence = evidencePool.filter((evidence, index) => (
    Boolean(evidence.url) && evidencePool.findIndex((candidate) => candidate.url === evidence.url) === index
  ));

  const rankedEvidence = uniqueEvidence.map((evidence) => ({
    evidence,
    score:
      (calculateTextSimilarity(`${evidence.title} ${evidence.content.slice(0, 700)}`, seedText) * 0.72) +
      (scoreInformativeText(evidence.content) * 0.18) +
      (scoreDomainAuthority(evidence.url) * 0.1),
  }));

  return balanceItemsByDomain(rankedEvidence, {
    maxItems,
    getDomain: ({ evidence }) => getSourceDomain(evidence.url),
    getScore: ({ score }) => score,
  }).map(({ evidence }) => evidence);
}

function summarizeFallbackDomains(evidencePool: FallbackEvidence[]): string {
  const domains = Array.from(new Set(
    evidencePool
      .map((evidence) => getSourceDomain(evidence.url))
      .filter((domain) => domain && domain !== 'unknown-source')
  )).slice(0, 3);

  if (domains.length === 0) {
    return 'multiple external sources';
  }

  if (domains.length === 1) {
    return domains[0];
  }

  if (domains.length === 2) {
    return `${domains[0]} and ${domains[1]}`;
  }

  return `${domains[0]}, ${domains[1]}, and ${domains[2]}`;
}

function summarizeFallbackAngles(evidencePool: FallbackEvidence[], topic: string): string {
  const labels: string[] = [];

  for (const evidence of evidencePool) {
    const label = deriveConceptLabel(evidence.title, topic);
    if (!label || labels.some((existing) => calculateTextSimilarity(existing, label) >= 0.74)) {
      continue;
    }

    labels.push(label);
    if (labels.length >= 3) {
      break;
    }
  }

  if (labels.length === 0) {
    return topic;
  }

  if (labels.length === 1) {
    return labels[0];
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
}

function buildFallbackParagraphLead(
  topic: string,
  chapterTitle: string,
  evidencePool: FallbackEvidence[],
  paragraphIndex: number
): string {
  const domains = summarizeFallbackDomains(evidencePool);
  const angles = summarizeFallbackAngles(evidencePool, topic);
  const normalizedChapterTitle = chapterTitle.trim();

  const templates = [
    `Coverage from ${domains} places ${normalizedChapterTitle} within the wider story of ${topic}, showing that the subject is best understood through several complementary sources rather than a single account.`,
    `Across these sources, attention moves from headline facts to the broader context surrounding ${angles}.`,
    `Taken together, the material adds texture to ${normalizedChapterTitle}, showing how adjacent sources explain the same theme from different but related angles.`,
    `A comparative view also reveals different emphases, especially where history, product identity, and brand positioning intersect.`,
    `This range of reporting links background, terminology, and consequences, giving the subject more shape and continuity.`,
    `Read together, these sources clarify why ${normalizedChapterTitle.toLowerCase()} matters within the broader context of ${topic}.`,
    `Additional reporting expands the subject beyond isolated facts and toward examples, context, and implications.`,
    `This broader mix of evidence helps the topic read as a sustained explanation rather than a collection of disconnected notes.`,
  ];

  return templates[paragraphIndex % templates.length];
}

function buildFallbackSourceCoverageParagraph(
  topic: string,
  chapterTitle: string,
  evidencePool: FallbackEvidence[]
): string {
  const domains = summarizeFallbackDomains(evidencePool);
  const angles = summarizeFallbackAngles(evidencePool, topic);
  return `Material from ${domains} returns repeatedly to ${angles}. That overlap helps ${chapterTitle.toLowerCase()} stay grounded in several credible sources while still reading as one continuous explanation of its place within ${topic}.`;
}

function buildFallbackSynthesisParagraph(
  topic: string,
  chapterTitle: string,
  summary: string,
  evidencePool: FallbackEvidence[]
): string {
  const domains = summarizeFallbackDomains(evidencePool);
  const angles = summarizeFallbackAngles(evidencePool, topic);
  const summarySentences = collectDistinctSentences([summary], 2)
    .filter((sentence) => !containsFallbackNarrativeMeta(sentence));
  const summaryBody = summarySentences.length > 0
    ? summarySentences.join(' ')
    : `${chapterTitle} sits at the intersection of several related sources rather than a single narrow perspective.`;

  return `Across ${domains}, ${chapterTitle.toLowerCase()} remains closely tied to the wider subject of ${topic}. ${summaryBody} Together, those recurring signals keep attention on ${angles} and help explain why this subject carries weight within the broader comparison.`;
}

function buildFallbackEvidenceParagraph(
  topic: string,
  chapterTitle: string,
  evidence: FallbackEvidence,
  index: number
): string {
  const domain = getSourceDomain(evidence.url);
  const sourceName = domain === 'unknown-source' ? 'a supporting source' : domain;
  const label = deriveConceptLabel(evidence.title, topic);
  const evidenceSentences = collectDistinctSentences([evidence.content], 2);
  const body = evidenceSentences.length > 0
    ? evidenceSentences.join(' ')
    : `${label} remains one of the recurring angles surrounding ${topic}.`;
  const closers = [
    `That perspective keeps ${chapterTitle.toLowerCase()} tied to concrete reporting instead of a single isolated claim.`,
    `It also widens the discussion by showing how this source approaches the subject from its own domain-specific point of view.`,
    `Placed beside other sources, that angle helps connect scattered facts into a more continuous explanation.`,
    `This added perspective is useful because it links specific examples back to the larger comparison.`,
  ];
  const bridgeSentences = [
    `It shows how multiple sources frame the same subject without erasing their differences in tone or emphasis.`,
    `It also helps connect terminology, context, and implications in a clearer sequence.`,
    `That makes the surrounding discussion easier to follow as part of the larger story.`,
    `In turn, the comparison feels broader and more grounded than any single source on its own.`,
  ];

  return `A related thread from ${sourceName} centers on ${label}. ${body} ${closers[index % closers.length]} ${bridgeSentences[index % bridgeSentences.length]}`;
}

function buildFallbackComparativeParagraph(
  topic: string,
  chapterTitle: string,
  evidencePool: FallbackEvidence[]
): string {
  const domains = summarizeFallbackDomains(evidencePool);
  const angles = summarizeFallbackAngles(evidencePool, topic);

  return `Placed beside one another, sources from ${domains} keep returning to ${angles}. That overlap suggests a shared core narrative around ${chapterTitle.toLowerCase()}, even as each source contributes its own mix of detail, framing, and emphasis.`;
}

function buildFallbackImplicationsParagraph(
  topic: string,
  chapterTitle: string,
  evidencePool: FallbackEvidence[]
): string {
  const angles = summarizeFallbackAngles(evidencePool, topic);
  const domains = summarizeFallbackDomains(evidencePool);

  return `Viewed in the wider context of ${topic}, these recurring themes help explain why ${chapterTitle.toLowerCase()} matters for brand identity, product strategy, and audience perception. With ${angles} recurring across ${domains}, the subject takes on a fuller and more plural shape.`;
}

function buildFallbackContinuityParagraph(
  topic: string,
  chapterTitle: string,
  summary: string
): string {
  const summarySentences = collectDistinctSentences([summary], 2)
    .filter((sentence) => !containsFallbackNarrativeMeta(sentence));
  const summaryTail = summarySentences.length > 0
    ? summarySentences.join(' ')
    : `The available search evidence still points to several adjacent ways of explaining ${chapterTitle.toLowerCase()}.`;

  return `Seen as a sequence, these sources turn ${chapterTitle.toLowerCase()} into a fuller explanation of ${topic}. ${summaryTail} The result is a clearer movement from background to example to broader significance.`;
}

function buildFallbackScopeParagraph(
  topic: string,
  chapterTitle: string,
  evidencePool: FallbackEvidence[]
): string {
  const domains = summarizeFallbackDomains(evidencePool);
  const angles = summarizeFallbackAngles(evidencePool, topic);

  return `The subject therefore extends beyond any single headline. Comparing how ${domains} discuss ${angles} shows the breadth of context, debate, and example surrounding ${chapterTitle.toLowerCase()}.`;
}

function appendUniqueParagraphs(paragraphs: string[], additions: string[]): string[] {
  for (const addition of additions) {
    const normalized = addition.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      continue;
    }

    if (containsFallbackNarrativeMeta(normalized)) {
      continue;
    }

    if (paragraphs.some((existing) => calculateTextSimilarity(existing, normalized) >= 0.78)) {
      continue;
    }

    paragraphs.push(normalized);
  }

  return paragraphs;
}

function buildFallbackSupplementalParagraphs(
  topic: string,
  chapterTitle: string,
  summary: string,
  evidencePool: FallbackEvidence[]
): string[] {
  return [
    buildFallbackSynthesisParagraph(topic, chapterTitle, summary, evidencePool),
    ...evidencePool
      .slice(0, Math.min(CHAPTER_SOURCE_CONTEXT_SIZE, evidencePool.length))
      .map((evidence, index) => buildFallbackEvidenceParagraph(topic, chapterTitle, evidence, index)),
    buildFallbackComparativeParagraph(topic, chapterTitle, evidencePool),
    buildFallbackImplicationsParagraph(topic, chapterTitle, evidencePool),
    buildFallbackContinuityParagraph(topic, chapterTitle, summary),
    buildFallbackScopeParagraph(topic, chapterTitle, evidencePool),
  ].filter(Boolean);
}

function buildFallbackNarrativeContent(
  topic: string,
  chapterTitle: string,
  summary: string,
  evidencePool: FallbackEvidence[],
  seenSentences: string[]
): { content: string; novelSentences: string[] } {
  const distinctEvidence = evidencePool.filter((evidence, index) => (
    Boolean(evidence.content) && evidencePool.findIndex((candidate) => candidate.url === evidence.url) === index
  ));
  const candidateSentences = filterReaderFacingFallbackSentences(collectDistinctSentences(
    [...distinctEvidence.map((evidence) => evidence.content), summary],
    FALLBACK_MAX_SENTENCE_POOL + 12
  ));
  const novelSentences = filterNovelSentences(candidateSentences, seenSentences, 0.84, FALLBACK_MAX_SENTENCE_POOL);
  const selectedSentences = novelSentences.length >= FALLBACK_MIN_SENTENCE_POOL
    ? novelSentences
    : candidateSentences.slice(0, FALLBACK_MAX_SENTENCE_POOL);
  if (selectedSentences.length === 0) {
    const fallbackSummarySentences = filterReaderFacingFallbackSentences(
      collectDistinctSentences([summary], 3)
    );

    if (fallbackSummarySentences.length === 0) {
      return {
        content: '',
        novelSentences: [],
      };
    }

    const summaryContent = fallbackSummarySentences.join(' ').trim();
    return {
      content: summaryContent,
      novelSentences: fallbackSummarySentences,
    };
  }

  const paragraphCount = Math.max(
    FALLBACK_TARGET_PARAGRAPH_COUNT,
    Math.min(8, Math.ceil(selectedSentences.length / 3))
  );
  let cursor = selectedSentences.length;
  const paragraphs = buildFallbackParagraphsFromSentences(selectedSentences, paragraphCount);

  let content = paragraphs.join('\n\n').trim();

  if (countWords(content) < FALLBACK_MIN_CHAPTER_WORD_COUNT && cursor < candidateSentences.length) {
    const remainingSentences = candidateSentences.slice(cursor, cursor + FALLBACK_MAX_SENTENCE_POOL);
    const extraParagraphs = buildFallbackParagraphsFromSentences(
      remainingSentences,
      Math.max(1, Math.ceil(remainingSentences.length / 3))
    );

    if (extraParagraphs.length > 0) {
      content = `${content}\n\n${extraParagraphs.join('\n\n')}`.trim();
    }
  }
  content = pruneFallbackNarrativeContent(content);
  if (!content) {
    return {
      content: '',
      novelSentences: [],
    };
  }

  const contentSentences = filterReaderFacingFallbackSentences(
    collectDistinctSentences([content], FALLBACK_MAX_SENTENCE_POOL)
  );

  return {
    content,
    novelSentences: contentSentences.length > 0 ? contentSentences : selectedSentences,
  };
}

function dedupeFallbackChapters(chapters: WebBook['chapters']): WebBook['chapters'] {
  const seenSentences: string[] = [];

  return chapters.map((chapter) => {
    const chapterSentences = filterReaderFacingFallbackSentences(
      collectDistinctSentences([chapter.content], FALLBACK_MAX_SENTENCE_POOL)
    );
    const novelSentences = filterNovelSentences(chapterSentences, seenSentences, 0.78, FALLBACK_MAX_SENTENCE_POOL);
    const retainedSentences = novelSentences.length >= Math.min(3, chapterSentences.length)
      ? novelSentences
      : (novelSentences.length > 0 ? novelSentences : chapterSentences.slice(0, Math.min(2, chapterSentences.length)));
    const rebuiltContent = buildFallbackParagraphsFromSentences(
      retainedSentences,
      Math.max(1, Math.min(FALLBACK_TARGET_PARAGRAPH_COUNT, Math.ceil(retainedSentences.length / 3)))
    ).join('\n\n').trim();

    const finalContent = rebuiltContent || chapter.content;
    seenSentences.push(...filterReaderFacingFallbackSentences(
      collectDistinctSentences([finalContent], FALLBACK_MAX_SENTENCE_POOL)
    ));

    return {
      ...chapter,
      content: finalContent,
    };
  });
}

function buildFallbackChapterContent(
  topic: string,
  page: WebPageGenotype,
  evidencePool: FallbackEvidence[],
  summary: string,
  seenSentences: string[]
): { content: string; novelSentences: string[] } {
  const pageEvidence = buildFallbackEvidenceFromPage(page);
  const relevantEvidence = selectRelevantFallbackEvidence(
    `${page.title} ${page.content}`,
    [pageEvidence, ...evidencePool.filter((evidence) => evidence.url !== page.url)],
    CHAPTER_SOURCE_CONTEXT_SIZE
  );
  const focusedSummary = buildFocusedFallbackChapterSummary(topic, page, relevantEvidence, summary);

  return buildFallbackNarrativeContent(topic, page.title, focusedSummary, relevantEvidence, seenSentences);
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
    return `Coverage of ${topic} draws on several related sources and recurring themes.`;
  }

  if (focusAreas.length === 1) {
    return `Coverage of ${topic} repeatedly returns to ${focusAreas[0]}.`;
  }

  if (focusAreas.length === 2) {
    return `Coverage of ${topic} often connects ${focusAreas[0]} and ${focusAreas[1]}.`;
  }

  return `Coverage of ${topic} often connects ${focusAreas[0]}, ${focusAreas[1]}, and ${focusAreas[2]}.`;
}

function buildFallbackSynthesisSummary(
  summary: string,
  chapterPages: WebPageGenotype[],
  topic: string,
  results: SearchFallbackResult[]
): string {
  const evidencePool: FallbackEvidence[] = [
    ...chapterPages.slice(0, CHAPTER_SOURCE_CONTEXT_SIZE).map((page) => buildFallbackEvidenceFromPage(page)),
    ...results.slice(0, CHAPTER_SOURCE_CONTEXT_SIZE).map((result) => buildFallbackEvidenceFromResult(result)),
  ];
  const synthesizedContent = buildFallbackNarrativeContent(
    topic,
    `${topic} overview`,
    summary,
    evidencePool,
    []
  ).content;

  if (synthesizedContent) {
    return synthesizedContent;
  }

  return buildFallbackTitleSynthesis(topic, results);
}

function distinctSourceReferences(sources: Array<{ title: string; url: string }>, maxSources: number): Array<{ title: string; url: string }> {
  const uniqueSources = sources.filter((source, index) => (
    Boolean(source.url) && sources.findIndex((candidate) => candidate.url === source.url) === index
  ));

  return balanceItemsByDomain(
    uniqueSources.map((source, index) => ({ source, index })),
    {
      maxItems: maxSources,
      getDomain: ({ source }) => getSourceDomain(source.url),
      getScore: ({ index }) => uniqueSources.length - index,
    }
  ).map(({ source }) => source);
}

function buildCompositeFallbackChapterTitle(topic: string, results: SearchFallbackResult[], index: number): string {
  const prefixes = [
    'Foundations',
    'Core Themes',
    'Practical Context',
    'Comparative Views',
    'Advanced Perspectives',
    'Reference Map',
  ];
  const labels: string[] = [];

  for (const result of results) {
    const label = deriveConceptLabel(result.title, topic);
    if (!label || labels.some((existing) => calculateTextSimilarity(existing, label) >= 0.74)) {
      continue;
    }

    labels.push(label);
    if (labels.length >= 2) {
      break;
    }
  }

  const prefix = prefixes[index % prefixes.length];
  if (labels.length === 0) {
    return `${prefix}: ${topic}`;
  }

  if (labels.length === 1) {
    return `${prefix}: ${labels[0]}`;
  }

  return `${prefix}: ${labels[0]} and ${labels[1]}`;
}

function buildSupplementalFallbackChapters(
  topic: string,
  results: SearchFallbackResult[],
  seenSentences: string[],
  maxChapters: number
): WebBook['chapters'] {
  const chapters: WebBook['chapters'] = [];
  const chunkSize = 4;

  for (let index = 0; index < results.length && chapters.length < maxChapters; index += chunkSize) {
    const chunk = results.slice(index, index + chunkSize);
    const chapterTitle = buildCompositeFallbackChapterTitle(topic, chunk, chapters.length);
    const { content, novelSentences } = buildFallbackNarrativeContent(
      topic,
      chapterTitle,
      buildFallbackTitleSynthesis(topic, chunk),
      chunk.map((result) => buildFallbackEvidenceFromResult(result)),
      seenSentences
    );

    if (!content) {
      continue;
    }

    seenSentences.push(...novelSentences);

    chapters.push({
      title: chapterTitle,
      content,
      definitions: getRenderableDefinitions([
        {
          term: topic,
          description: content,
          sourceUrl: buildSearchUrl(topic),
        },
        ...chunk.map((result) => ({
          term: deriveConceptLabel(result.title, topic),
          description: result.snippet,
          sourceUrl: result.url,
        })),
      ], 6),
      subTopics: getRenderableSubTopics(
        chunk.map((result) => ({
          title: result.title,
          summary: result.snippet,
          sourceUrl: result.url,
        }))
      ).slice(0, 5),
      sourceUrls: distinctSourceReferences(
        chunk.map((result) => ({ title: result.title, url: result.url })),
        CHAPTER_SOURCE_CONTEXT_SIZE
      ),
      visualSeed: deriveConceptLabel(chunk[0]?.title || topic, topic),
    });
  }

  return chapters;
}

function selectDistinctFallbackPages(
  topic: string,
  pages: WebPageGenotype[],
  summary: string,
  maxPages = ASSEMBLY_SOURCE_POOL_SIZE
): WebPageGenotype[] {
  const distinct: WebPageGenotype[] = [];
  const seenSentences: string[] = [];
  const evidencePool = pages.map((page) => buildFallbackEvidenceFromPage(page));

  for (const page of pages) {
    if (!page.content?.trim()) {
      continue;
    }

    const { content: pageBody, novelSentences } = buildFallbackChapterContent(
      topic,
      page,
      evidencePool,
      summary,
      seenSentences
    );
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
  const distinctFallbackResults = fallbackPayload
    ? selectDistinctFallbackResults(fallbackPayload.results, CONSOLIDATED_SOURCE_POOL_SIZE)
    : [];
  const referenceSources = distinctSourceReferences(
    distinctFallbackResults.map((result) => ({ title: result.title, url: result.url })),
    10
  );
  const payloadPages = fallbackPayload ? buildFallbackPopulation({ ...fallbackPayload, results: distinctFallbackResults }).slice(1) : [];
  const populationPages = selectDistinctPopulationPages(
    optimalPopulation.filter((page) => !isSyntheticPage(page) && page.url !== searchUrl),
    CONSOLIDATED_SOURCE_POOL_SIZE
  );
  const candidatePages = selectDistinctPopulationPages([
    ...payloadPages,
    ...populationPages.filter((page) => !payloadPages.some((payloadPage) => payloadPage.url === page.url)),
  ], ASSEMBLY_SOURCE_POOL_SIZE - 1);

  if (candidatePages.length === 0 && !hasUsableFallbackPayload(fallbackPayload)) {
    throw new Error(
      `No live fallback search evidence or retained source pages were available to assemble a Web-book for "${topic}".`
    );
  }

  const candidateEvidence = [
    ...candidatePages.map((page) => buildFallbackEvidenceFromPage(page)),
    ...distinctFallbackResults.map((result) => buildFallbackEvidenceFromResult(result)),
  ];
  const chapterPages = selectDistinctFallbackPages(
    topic,
    candidatePages,
    rawSummary,
    ASSEMBLY_SOURCE_POOL_SIZE - 1
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
    title: 'Comparative Overview',
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
    ], 8),
    subTopics: getRenderableSubTopics([
      ...uncoveredResults.slice(0, 4).map((result) => ({
        title: result.title,
        summary: result.snippet,
        sourceUrl: result.url,
      })),
    ]).slice(0, 6),
    sourceUrls: distinctSourceReferences([...referenceSources, { title: 'Google Search', url: searchUrl }], CHAPTER_SOURCE_CONTEXT_SIZE),
    visualSeed: topic,
  };

  const sourceChapters = chapterPages
    .map((page) => {
      const relatedEvidence = selectRelevantFallbackEvidence(
        `${page.title} ${page.content}`,
        [
          buildFallbackEvidenceFromPage(page),
          ...candidateEvidence.filter((evidence) => evidence.url !== page.url),
        ],
        CHAPTER_SOURCE_CONTEXT_SIZE + 1
      );

      return {
        title: page.title,
        content: page.content,
        definitions: getRenderableDefinitions(page.definitions || [], 8),
        subTopics: getRenderableSubTopics(page.subTopics || []).slice(0, 6),
        sourceUrls: distinctSourceReferences(
          [
            { title: page.title, url: page.url },
            ...relatedEvidence
              .filter((evidence) => evidence.url !== page.url)
              .map((evidence) => ({ title: evidence.title, url: evidence.url })),
            ...referenceSources.filter((source) => source.url !== page.url),
          ],
          CHAPTER_SOURCE_CONTEXT_SIZE
        ),
        visualSeed: deriveConceptLabel(page.title, topic),
      };
    })
    .filter((chapter) => chapter.content && chapter.content.trim().length > 0);
  const chapterPool = [synthesisChapter, ...sourceChapters];
  const seenChapterSentences = dedupeSentences(
    chapterPool.map((chapter) => chapter.content).join(' '),
    120
  );
  const supplementalChapters = buildSupplementalFallbackChapters(
    topic,
    uncoveredResults,
    seenChapterSentences,
    Math.max(0, ASSEMBLY_SOURCE_POOL_SIZE - chapterPool.length)
  );
  const finalChapters = dedupeFallbackChapters(
    [...chapterPool, ...supplementalChapters].slice(0, FINAL_WEBBOOK_CHAPTER_COUNT)
  );

  if (!hasRenderableChapters(finalChapters)) {
    throw new Error(
      `Fallback search did not yield enough renderable external evidence to assemble a Web-book for "${topic}".`
    );
  }

  return {
    topic,
    chapters: finalChapters,
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
    const incompleteGeminiOutput = isGeminiOutputIncomplete(error);
    if (!fallbackReason && !incompleteGeminiOutput) {
      throw error;
    }

    let fallbackPayload = context?.fallbackPayload;
    if (!fallbackPayload) {
      fallbackPayload = await safeFetchSearchFallback(
        topic,
        incompleteGeminiOutput ? 'Gemini assembly completeness recovery' : 'Gemini assembly recovery'
      );
    }

    const fallbackSource = fallbackPayload?.source || context?.fallbackSource || 'google-search-snippets';
    const generationNote = fallbackReason
      ? (fallbackPayload
        ? buildFallbackNoticeFromPayload(fallbackReason, fallbackPayload)
        : `${buildFallbackNotice(fallbackReason, fallbackSource, 'google')} Live fallback search was unavailable, so the Web-book was assembled from the current evidence pool only.`)
      : buildIncompleteGeminiFallbackNotice(Boolean(fallbackPayload));

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
