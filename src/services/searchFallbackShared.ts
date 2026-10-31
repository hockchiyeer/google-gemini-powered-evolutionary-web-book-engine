import type {
  SearchArtifact,
  SearchFallbackMode,
  SearchFallbackPayload,
  SearchFallbackProvider,
} from '../types';

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_PUBLIC_SEARCH_URL = 'https://duckduckgo.com/';
// Marks a placeholder payload that was fabricated because no live search evidence was found.
export const SYNTHETIC_FALLBACK_DIAGNOSTIC = 'Synthetic fallback payload generated due to limited search evidence.';
export const FALLBACK_STOPWORDS = new Set([
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

/** Canonical CJK character range covering Chinese, Japanese, Korean, and compatibility ideographs. */
export const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

export function countWords(text: string): number {
  const cjkCount = (text.match(CJK_CHAR_PATTERN) || []).length;
  const nonCjk = text.replace(CJK_CHAR_PATTERN, ' ').trim();
  const nonCjkWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
  return cjkCount + nonCjkWords;
}

export function isCjkMajority(text: string): boolean {
  const cjkCount = (text.match(CJK_CHAR_PATTERN) || []).length;
  const nonWsLength = text.replace(/\s+/g, '').length;
  return nonWsLength > 0 && cjkCount / nonWsLength >= 0.4;
}

export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？][”’」』）)]*)(?![”’」』）)])\s*/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function normalizeComparableText(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/([a-z0-9]+)([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])/gi, '$1 $2')
    .replace(/([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])([a-z0-9]+)/gi, '$1 $2')
    .replace(/[^\w\s\u0080-\u024f\u0370-\u03ff\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeComparableText(input: string): string[] {
  const norm = normalizeComparableText(input);
  const words = norm
    .split(' ')
    .filter((token) => token.length >= 3 && !FALLBACK_STOPWORDS.has(token));

  const cjkChars = norm.match(CJK_CHAR_PATTERN);
  if (cjkChars && cjkChars.length > 0) {
    for (let i = 0; i < cjkChars.length - 1; i++) {
      words.push(cjkChars[i] + cjkChars[i + 1]);
    }
    if (cjkChars.length === 1) {
      words.push(cjkChars[0]);
    }
  }

  return words;
}

export function calculateTextSimilarity(left: string, right: string): number {
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

export function getFallbackResultCount(
  payload: SearchFallbackPayload,
  provider: SearchFallbackProvider
): number {
  // DuckDuckGo evidence can come from its HTML, Lite or Instant Answer endpoints, each reported separately.
  const prefixes = provider === 'duckduckgo'
    ? ['duckduckgo-results:', 'duckduckgo-lite-results:', 'duckduckgo-instant-results:']
    : [`${provider}-results:`];
  const counts = (payload.diagnostics || []).flatMap((entry) => (
    prefixes
      .filter((prefix) => entry.startsWith(prefix))
      .map((prefix) => Number.parseInt(entry.slice(prefix.length), 10))
  )).filter((count) => Number.isFinite(count));

  if (counts.length === 0) {
    return payload.provider === provider ? payload.results.length : 0;
  }

  return counts.reduce((total, count) => total + count, 0);
}

export function hasDuckDuckGoFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return getFallbackResultCount(payload, 'duckduckgo') > 0;
}

export function hasGoogleFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return payload.source === 'google-ai-overview' || getFallbackResultCount(payload, 'google') > 0;
}

export function isSyntheticFallbackPayload(payload?: SearchFallbackPayload): boolean {
  return Boolean(payload?.diagnostics?.includes(SYNTHETIC_FALLBACK_DIAGNOSTIC));
}

/** Reports which fallback providers actually contributed evidence, for user-facing notices and metadata. */
export function describeFallbackEvidence(
  payload: SearchFallbackPayload,
  mode: SearchFallbackMode
): { label: string; source: 'google' | 'duckduckgo' | 'google_duckduckgo' } {
  let google = hasGoogleFallbackEvidence(payload);
  let duckduckgo = hasDuckDuckGoFallbackEvidence(payload);

  if (!google && !duckduckgo) {
    // Payloads without per-provider diagnostics: fall back to the declared provider.
    google = payload.provider !== 'duckduckgo';
    duckduckgo = payload.provider === 'duckduckgo' || payload.provider === 'google_duckduckgo';
  }

  if (google && duckduckgo) {
    return { label: 'Google fallback + DuckDuckGo fallback', source: 'google_duckduckgo' };
  }

  if (google) {
    return {
      label: mode === 'google_duckduckgo' ? 'Google fallback (DuckDuckGo contributed no results)' : 'Google fallback',
      source: 'google',
    };
  }

  return {
    label: mode === 'google_duckduckgo' ? 'DuckDuckGo fallback (Google contributed no results)' : 'DuckDuckGo fallback',
    source: 'duckduckgo',
  };
}

export function buildFallbackOverviewTitle(payload: SearchFallbackPayload): string {
  if (payload.source === 'google-ai-overview') {
    return hasDuckDuckGoFallbackEvidence(payload)
      ? `${payload.query} - Google AI Overview + DuckDuckGo Cross-Check`
      : `${payload.query} - Google AI Overview`;
  }

  if (hasGoogleFallbackEvidence(payload) && hasDuckDuckGoFallbackEvidence(payload)) {
    return `${payload.query} - Google + DuckDuckGo Search Summary`;
  }

  return payload.provider === 'duckduckgo'
    ? `${payload.query} - DuckDuckGo Search Summary`
    : `${payload.query} - Google Search Summary`;
}

export function buildFallbackSearchUrl(
  query: string,
  provider: SearchFallbackProvider = 'google'
): string {
  const searchUrl = new URL(provider === 'duckduckgo' ? DUCKDUCKGO_PUBLIC_SEARCH_URL : GOOGLE_SEARCH_URL);
  searchUrl.searchParams.set('q', query);

  if (provider === 'duckduckgo') {
    searchUrl.searchParams.set('ia', 'web');
  }

  return searchUrl.toString();
}

export function deriveConceptLabel(title: string, fallbackQuery: string): string {
  const firstSegment = title.split(/[-:|—–]/)[0]?.trim();
  if (firstSegment && firstSegment.length >= 2) {
    return firstSegment;
  }

  return fallbackQuery;
}

export function scoreDomainAuthority(url: string): number {
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

export function scoreInformativeText(text: string): number {
  const wordCount = countWords(text);
  const sentenceCount = text.split(/[.!?。！？]+/).filter((segment) => segment.trim().length > 0).length;
  return Math.min(0.98, 0.35 + Math.min(wordCount / 180, 0.38) + Math.min(sentenceCount / 10, 0.25));
}

export function mapFallbackArtifacts(payload: SearchFallbackPayload): SearchArtifact[] {
  return payload.results.map((result) => ({
    web: {
      title: result.title,
      uri: result.url,
    },
    snippet: result.snippet,
  }));
}
