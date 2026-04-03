import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { SearchFallbackPayload, SearchFallbackProvider, SearchFallbackResult } from '../src/types';

const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 6;
const MAX_SUMMARY_LENGTH = 1400;
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

const DEFAULT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
};

const AI_OVERVIEW_STOP_HEADINGS = [
  'people also ask',
  'top stories',
  'videos',
  'images',
  'discussions and forums',
  'related searches',
  'see results about',
  'knowledge panel',
  'sources',
];

const NAVIGATION_NOISE = [
  'sign in',
  'all',
  'news',
  'images',
  'videos',
  'shopping',
  'maps',
  'books',
  'flights',
  'finance',
  'tools',
  'more',
  'next',
  'previous',
  'cached',
  'translate this page',
];

interface SearchFetchResult {
  label: string;
  url: string;
  status: number;
  html: string;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, value: string) => {
    if (value[0] === '#') {
      const numericValue = value[1]?.toLowerCase() === 'x'
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);

      if (Number.isFinite(numericValue)) {
        return String.fromCodePoint(numericValue);
      }

      return entity;
    }

    switch (value) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        return entity;
    }
  });
}

function collapseWhitespace(input: string): string {
  return input.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(input: string): string {
  return collapseWhitespace(
    input
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
  );
}

function tokenizeComparableText(input: string): string[] {
  return normalizeComparableText(input)
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

function stripHtmlToText(input: string): string {
  return collapseWhitespace(
    decodeHtmlEntities(
      input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|section|article|table|tr|td|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

function stripHtmlToLines(input: string): string[] {
  const normalized = decodeHtmlEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|section|article|table|tr|td|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );

  return normalized
    .split(/\n+/)
    .map((line) => collapseWhitespace(line))
    .filter(Boolean);
}

function normalizeGoogleSearchHref(rawHref: string): string | null {
  try {
    const decodedHref = decodeHtmlEntities(rawHref);

    if (decodedHref.startsWith('http://') || decodedHref.startsWith('https://')) {
      return decodedHref;
    }

    const url = new URL(decodedHref, 'https://www.google.com');
    if (url.hostname !== 'www.google.com' && url.hostname !== 'google.com') {
      return url.toString();
    }

    if (url.pathname === '/url') {
      return url.searchParams.get('q') || url.searchParams.get('url');
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeDuckDuckGoHref(rawHref: string): string | null {
  try {
    const decodedHref = decodeHtmlEntities(rawHref);
    const url = new URL(decodedHref, 'https://duckduckgo.com');

    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      return url.searchParams.get('uddg');
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function isExternalResultUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.replace(/^www\./, '');
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      hostname !== 'google.com' &&
      !hostname.endsWith('.google.com') &&
      hostname !== 'youtube.com' &&
      !hostname.endsWith('.youtube.com') &&
      hostname !== 'duckduckgo.com'
    );
  } catch {
    return false;
  }
}

function isLikelyResultTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  if (title.length < 12 || title.length > 180) return false;
  if (NAVIGATION_NOISE.some((noise) => normalized === noise || normalized.startsWith(`${noise} `))) {
    return false;
  }
  return /[a-z]{3}/i.test(title);
}

function extractSnippetFromContext(contextHtml: string, title: string): string {
  const snippetPatterns = [
    /<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*BNeawe[^"]*s3v9rd[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<span[^>]*class="[^"]*aCOpRe[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<div[^>]*data-sncf="[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of snippetPatterns) {
    const match = contextHtml.match(pattern);
    if (!match?.[1]) continue;

    const snippet = stripHtmlToText(match[1]);
    if (snippet.length >= 40) {
      return snippet.slice(0, 420);
    }
  }

  const plainText = stripHtmlToText(contextHtml)
    .replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
    .trim();

  return plainText.slice(0, 420);
}

function extractSearchResultsFromGoogleHtml(html: string): SearchFallbackResult[] {
  const anchorPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set<string>();
  const results: SearchFallbackResult[] = [];

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
    const url = normalizeGoogleSearchHref(match[1]);
    if (!url || !isExternalResultUrl(url) || seenUrls.has(url)) {
      continue;
    }

    const title = stripHtmlToText(match[2]);
    if (!isLikelyResultTitle(title)) {
      continue;
    }

    const contextStart = match.index + match[0].length;
    const contextHtml = html.slice(contextStart, contextStart + 3000);
    const snippet = extractSnippetFromContext(contextHtml, title);
    if (snippet.length < 40) {
      continue;
    }

    try {
      const parsedUrl = new URL(url);
      results.push({
        title,
        url,
        domain: parsedUrl.hostname.replace(/^www\./, ''),
        snippet,
      });
      seenUrls.add(url);
    } catch {
      // Ignore malformed URLs.
    }
  }

  return results;
}

function extractSearchResultsFromDuckDuckGoHtml(html: string): SearchFallbackResult[] {
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set<string>();
  const results: SearchFallbackResult[] = [];

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
    const url = normalizeDuckDuckGoHref(match[1]);
    if (!url || !isExternalResultUrl(url) || seenUrls.has(url)) {
      continue;
    }

    const title = stripHtmlToText(match[2]);
    if (!isLikelyResultTitle(title)) {
      continue;
    }

    const contextHtml = html.slice(match.index, match.index + 2800);
    const snippet = extractSnippetFromContext(contextHtml, title);
    if (snippet.length < 40) {
      continue;
    }

    try {
      const parsedUrl = new URL(url);
      results.push({
        title,
        url,
        domain: parsedUrl.hostname.replace(/^www\./, ''),
        snippet,
      });
      seenUrls.add(url);
    } catch {
      // Ignore malformed URLs.
    }
  }

  return results;
}

function extractAiOverview(html: string): string[] {
  const lines = stripHtmlToLines(html);
  const startIndex = lines.findIndex((line) => /ai overview/i.test(line));
  if (startIndex < 0) {
    return [];
  }

  const overview: string[] = [];
  for (const line of lines.slice(startIndex + 1, startIndex + 28)) {
    const normalized = line.toLowerCase();

    if (AI_OVERVIEW_STOP_HEADINGS.some((heading) => normalized.includes(heading))) {
      break;
    }

    if (line.length < 48 || line.length > 420) {
      continue;
    }

    if (overview.includes(line)) {
      continue;
    }

    overview.push(line);
    if (overview.join(' ').length >= 900) {
      break;
    }
  }

  return overview;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => collapseWhitespace(sentence))
    .filter((sentence) => sentence.length >= 35);
}

function dedupeSentences(text: string, maxSentences = Number.POSITIVE_INFINITY): string[] {
  const unique: string[] = [];

  for (const sentence of splitIntoSentences(text)) {
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
  const cleaned = collapseWhitespace(text.replace(/\.\.\.\s*(?=[A-Z])/g, ' '));
  const uniqueSentences = dedupeSentences(cleaned, 4);
  return uniqueSentences.length > 0 ? uniqueSentences.join(' ') : cleaned;
}

function selectDistinctSearchResults(results: SearchFallbackResult[], maxResults = MAX_RESULTS): SearchFallbackResult[] {
  const distinct: SearchFallbackResult[] = [];

  for (const result of results) {
    const candidate: SearchFallbackResult = {
      ...result,
      title: collapseWhitespace(result.title),
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

function buildSummary(query: string, aiOverview: string[], results: SearchFallbackResult[]): string {
  if (aiOverview.length > 0) {
    return sanitizeFallbackSnippet(aiOverview.join(' ')).slice(0, MAX_SUMMARY_LENGTH);
  }

  const collected: string[] = [];

  for (const result of results) {
    for (const sentence of dedupeSentences(result.snippet, 4)) {
      if (collected.some((existing) => calculateTextSimilarity(existing, sentence) >= 0.88)) {
        continue;
      }

      collected.push(sentence);
      if (collected.join(' ').length >= MAX_SUMMARY_LENGTH) {
        break;
      }
    }

    if (collected.join(' ').length >= MAX_SUMMARY_LENGTH) {
      break;
    }
  }

  if (collected.length > 0) {
    return collected.join(' ').slice(0, MAX_SUMMARY_LENGTH);
  }

  const titles = results.map((result) => result.title).slice(0, 4).join('; ');
  return `Search results for ${query} highlighted these sources: ${titles}.`;
}

function isGoogleBlockedPage(html: string): boolean {
  const normalized = stripHtmlToText(html).toLowerCase();
  return (
    normalized.includes('about this page') ||
    normalized.includes('unusual traffic from your computer network') ||
    normalized.includes('detected unusual traffic') ||
    normalized.includes('not a robot') ||
    normalized.includes('please click here if you are not redirected within a few seconds')
  );
}

async function fetchSearchHtml(url: URL, label: string, headers: Record<string, string> = DEFAULT_HEADERS): Promise<SearchFetchResult> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  return {
    label,
    url: response.url,
    status: response.status,
    html: await response.text(),
  };
}

async function fetchGoogleAttempts(query: string): Promise<SearchFetchResult[]> {
  const desktopUrl = new URL(GOOGLE_SEARCH_URL);
  desktopUrl.searchParams.set('q', query);
  desktopUrl.searchParams.set('hl', 'en');
  desktopUrl.searchParams.set('gl', 'us');
  desktopUrl.searchParams.set('num', '10');
  desktopUrl.searchParams.set('pws', '0');

  const basicUrl = new URL(desktopUrl.toString());
  basicUrl.searchParams.set('gbv', '1');

  const webOnlyUrl = new URL(desktopUrl.toString());
  webOnlyUrl.searchParams.set('udm', '14');

  const attempts = await Promise.allSettled([
    fetchSearchHtml(desktopUrl, 'google-desktop'),
    fetchSearchHtml(basicUrl, 'google-basic'),
    fetchSearchHtml(webOnlyUrl, 'google-web'),
  ]);

  return attempts.flatMap((attempt) => attempt.status === 'fulfilled' ? [attempt.value] : []);
}

async function fetchDuckDuckGoAttempt(query: string): Promise<SearchFetchResult | null> {
  const searchUrl = new URL(DUCKDUCKGO_SEARCH_URL);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('kl', 'us-en');

  try {
    return await fetchSearchHtml(searchUrl, 'duckduckgo-html');
  } catch {
    return null;
  }
}

function buildDiagnostics(fetches: SearchFetchResult[], resultsCount: number, provider: SearchFallbackProvider): string[] {
  const diagnostics = fetches.map((attempt) => {
    const blockedNote = provider === 'google' && isGoogleBlockedPage(attempt.html) ? ' blocked-by-google' : '';
    return `${attempt.label}:${attempt.status}${blockedNote}`;
  });

  diagnostics.push(`${provider}-results:${resultsCount}`);
  return diagnostics;
}

export async function buildGoogleSearchFallbackPayload(query: string): Promise<SearchFallbackPayload> {
  const googleAttempts = await fetchGoogleAttempts(query);
  const aiOverview = googleAttempts.flatMap((attempt) => extractAiOverview(attempt.html));
  const googleResults = selectDistinctSearchResults(googleAttempts
    .flatMap((attempt) => extractSearchResultsFromGoogleHtml(attempt.html))
    .reduce<SearchFallbackResult[]>((accumulator, result) => {
      if (accumulator.some((item) => item.url === result.url) || accumulator.length >= MAX_RESULTS) {
        return accumulator;
      }

      accumulator.push(result);
      return accumulator;
    }, []));

  if (aiOverview.length > 0 || googleResults.length > 0) {
    return {
      query,
      source: aiOverview.length > 0 ? 'google-ai-overview' : 'google-search-snippets',
      provider: 'google',
      summary: buildSummary(query, aiOverview, googleResults),
      aiOverview,
      results: googleResults,
      extractedAt: Date.now(),
      diagnostics: buildDiagnostics(googleAttempts, googleResults.length, 'google'),
    };
  }

  const duckDuckGoAttempt = await fetchDuckDuckGoAttempt(query);
  const alternateResults = duckDuckGoAttempt
    ? selectDistinctSearchResults(extractSearchResultsFromDuckDuckGoHtml(duckDuckGoAttempt.html))
    : [];

  if (alternateResults.length > 0) {
    const diagnostics = buildDiagnostics(googleAttempts, googleResults.length, 'google');
    if (duckDuckGoAttempt) {
      diagnostics.push(...buildDiagnostics([duckDuckGoAttempt], alternateResults.length, 'duckduckgo'));
    }

    return {
      query,
      source: 'alternate-search-snippets',
      provider: 'duckduckgo',
      summary: buildSummary(query, [], alternateResults),
      aiOverview: [],
      results: alternateResults,
      extractedAt: Date.now(),
      diagnostics,
    };
  }

  const diagnostics = buildDiagnostics(googleAttempts, googleResults.length, 'google');
  if (duckDuckGoAttempt) {
    diagnostics.push(...buildDiagnostics([duckDuckGoAttempt], alternateResults.length, 'duckduckgo'));
  } else {
    diagnostics.push('duckduckgo-html:fetch-failed');
  }

  throw new Error(`No extractable search snippets were available. ${diagnostics.join(' | ')}`);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function createFallbackMiddleware() {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    if (!request.url) {
      next();
      return;
    }

    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname !== SEARCH_FALLBACK_ROUTE) {
      next();
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }

    const query = requestUrl.searchParams.get('query')?.trim();
    if (!query) {
      sendJson(response, 400, { error: 'Query is required' });
      return;
    }

    try {
      const payload = await buildGoogleSearchFallbackPayload(query);
      sendJson(response, 200, payload);
    } catch (error) {
      console.error('Google search fallback failed', error);
      const message = error instanceof Error ? error.message : 'Unable to extract search fallback results at the moment.';
      sendJson(response, 502, {
        error: message,
      });
    }
  };
}

export function googleSearchFallbackPlugin(): Plugin {
  const middleware = createFallbackMiddleware();

  return {
    name: 'google-search-fallback',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

