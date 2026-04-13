import type {
  SearchArtifact,
  SearchFallbackPayload,
  SearchFallbackProvider,
} from '../types';

const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_PUBLIC_SEARCH_URL = 'https://duckduckgo.com/';
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

function normalizeComparableText(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeComparableText(input: string): string[] {
  return normalizeComparableText(input)
    .split(' ')
    .filter((token) => token.length >= 3 && !FALLBACK_STOPWORDS.has(token));
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
  const diagnostic = payload.diagnostics?.find((entry) => entry.startsWith(`${provider}-results:`));
  if (!diagnostic) {
    return payload.provider === provider ? payload.results.length : 0;
  }

  const count = Number.parseInt(diagnostic.split(':')[1] || '0', 10);
  return Number.isFinite(count) ? count : 0;
}

export function hasDuckDuckGoFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return getFallbackResultCount(payload, 'duckduckgo') > 0;
}

export function hasGoogleFallbackEvidence(payload: SearchFallbackPayload): boolean {
  return payload.source === 'google-ai-overview' || getFallbackResultCount(payload, 'google') > 0;
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
  const firstSegment = title.split(/[-:|]/)[0]?.trim();
  if (firstSegment && firstSegment.length >= 4) {
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
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const sentenceCount = text.split(/[.!?]+/).filter((segment) => segment.trim().length > 0).length;
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
