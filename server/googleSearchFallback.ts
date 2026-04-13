import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { getRenderableDefinitions, getRenderableSubTopics } from '../src/utils/webBookRender.ts';
import type {
  SearchFallbackMode,
  SearchFallbackPayload,
  SearchFallbackResult,
  WebPageGenotype,
  SearchFallbackProvider,
} from '../src/types.ts';
import { isSearchFallbackMode } from '../src/types.ts';
import {
  buildFallbackOverviewTitle,
  buildFallbackSearchUrl as buildSearchUrl,
  calculateTextSimilarity,
  deriveConceptLabel,
  hasDuckDuckGoFallbackEvidence,
  mapFallbackArtifacts,
  scoreDomainAuthority,
  scoreInformativeText,
} from '../src/services/searchFallbackShared.ts';

const SEARCH_ROUTE = '/api/search';
const EVOLVE_ROUTE = '/api/evolve';
const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DUCKDUCKGO_INSTANT_ANSWER_URL = 'https://api.duckduckgo.com/';
// Escalate to Lite endpoint when standard HTML yields fewer than this many results.
const DUCKDUCKGO_LITE_ESCALATION_THRESHOLD = 4;
const MAX_RESULTS = 48;
const MAX_RESULTS_PER_DOCUMENT = 12;
const MAX_SUMMARY_LENGTH = 2200;
const GOOGLE_QUERY_VARIANT_LIMIT = 2;
const GOOGLE_RESULT_TARGET = 8;
const GOOGLE_VARIANT_DELAY_MS = 350;
const SEARCH_QUERY_VARIANTS = [
  '',
  'overview',
  'guide',
  'key concepts',
  'applications',
  'history',
];

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

const LEGACY_EVOLUTION_WEIGHTS = { alpha: 0.5, beta: 0.3, gamma: 0.2 };

interface SearchFetchResult {
  label: string;
  url: string;
  status: number;
  html: string;
}

type RequestPayload = Record<string, unknown>;

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchQueryVariants(query: string): string[] {
  const baseQuery = collapseWhitespace(query);
  const normalizedBase = normalizeComparableText(baseQuery);
  const variants: string[] = [];
  const seen = new Set<string>();

  for (const suffix of SEARCH_QUERY_VARIANTS) {
    const candidate = suffix
      ? `${baseQuery} ${suffix}`
      : baseQuery;
    const normalizedCandidate = normalizeComparableText(candidate);

    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue;
    }

    if (suffix !== '' && normalizedCandidate === normalizedBase) {
      continue;
    }

    seen.add(normalizedCandidate);
    variants.push(candidate);
  }

  return variants.length > 0 ? variants : [baseQuery];
}
function normalizeComparableText(input: string): string {
  return collapseWhitespace(
    input
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
  );
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
      const target = url.searchParams.get('uddg');
      if (!target) return null;

      try {
        return decodeURIComponent(target);
      } catch {
        return target;
      }
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
  while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_RESULTS_PER_DOCUMENT) {
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
  const anchorPatterns = [
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  const seenUrls = new Set<string>();
  const results: SearchFallbackResult[] = [];

  for (const anchorPattern of anchorPatterns) {
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html)) !== null && results.length < MAX_RESULTS_PER_DOCUMENT) {
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
  }

  return results;
}

function collectInstantAnswerTopics(topics: any[]): Array<{ text: string; firstUrl: string }> {
  const collected: Array<{ text: string; firstUrl: string }> = [];

  for (const topic of topics || []) {
    if (!topic || typeof topic !== 'object') {
      continue;
    }

    if (Array.isArray(topic.Topics)) {
      collected.push(...collectInstantAnswerTopics(topic.Topics));
      continue;
    }

    const text = collapseWhitespace(String(topic.Text || ''));
    const firstUrl = String(topic.FirstURL || '');
    if (!text || !firstUrl) {
      continue;
    }

    collected.push({ text, firstUrl });
  }

  return collected;
}

function extractSearchResultsFromDuckDuckGoInstantAnswer(payload: any): SearchFallbackResult[] {
  const candidates: SearchFallbackResult[] = [];
  const pushCandidate = (title: string, url: string, snippet: string) => {
    if (!title || !url || !snippet || !isExternalResultUrl(url)) {
      return;
    }

    try {
      const parsed = new URL(url);
      candidates.push({
        title: collapseWhitespace(title).slice(0, 180),
        url: parsed.toString(),
        domain: parsed.hostname.replace(/^www\./, ''),
        snippet: collapseWhitespace(snippet).slice(0, 420),
      });
    } catch {
      // Ignore malformed URLs.
    }
  };

  const abstractText = collapseWhitespace(String(payload?.AbstractText || ''));
  const abstractUrl = String(payload?.AbstractURL || '');
  const heading = collapseWhitespace(String(payload?.Heading || ''));
  if (abstractText.length >= 40 && abstractUrl) {
    pushCandidate(heading || 'DuckDuckGo Instant Answer', abstractUrl, abstractText);
  }

  const definition = collapseWhitespace(String(payload?.Definition || ''));
  const definitionUrl = String(payload?.DefinitionURL || '');
  const entity = collapseWhitespace(String(payload?.Entity || ''));
  if (definition.length >= 40 && definitionUrl) {
    pushCandidate(entity || heading || 'DuckDuckGo Definition', definitionUrl, definition);
  }

  const relatedTopics = collectInstantAnswerTopics(payload?.RelatedTopics || []);
  relatedTopics.slice(0, MAX_RESULTS_PER_DOCUMENT).forEach((topic) => {
    if (topic.text.length < 40) return;

    const title = topic.text.split(/[-|:]/)[0]?.trim() || heading || 'DuckDuckGo Topic';
    pushCandidate(title, topic.firstUrl, topic.text);
  });

  return selectDistinctSearchResults(candidates, MAX_RESULTS_PER_DOCUMENT);
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

function interleaveSearchResults(primary: SearchFallbackResult[], secondary: SearchFallbackResult[]): SearchFallbackResult[] {
  const interleaved: SearchFallbackResult[] = [];
  const maxLength = Math.max(primary.length, secondary.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (primary[index]) {
      interleaved.push(primary[index]);
    }
    if (secondary[index]) {
      interleaved.push(secondary[index]);
    }
  }

  return interleaved;
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

async function fetchGoogleAttempts(query: string, labelSuffix: string): Promise<SearchFetchResult[]> {
  const desktopUrl = new URL(GOOGLE_SEARCH_URL);
  desktopUrl.searchParams.set('q', query);
  desktopUrl.searchParams.set('hl', 'en');
  desktopUrl.searchParams.set('gl', 'us');
  desktopUrl.searchParams.set('num', '12');
  desktopUrl.searchParams.set('pws', '0');

  const basicUrl = new URL(desktopUrl.toString());
  basicUrl.searchParams.set('gbv', '1');

  const webOnlyUrl = new URL(desktopUrl.toString());
  webOnlyUrl.searchParams.set('udm', '14');

  const attempts: SearchFetchResult[] = [];
  const searchTargets: Array<{ url: URL; label: string }> = [
    { url: desktopUrl, label: `google-desktop-${labelSuffix}` },
    { url: basicUrl, label: `google-basic-${labelSuffix}` },
    { url: webOnlyUrl, label: `google-web-${labelSuffix}` },
  ];

  for (const [index, target] of searchTargets.entries()) {
    try {
      const attempt = await fetchSearchHtml(target.url, target.label);
      attempts.push(attempt);

      if (isBlockedGoogleAttempt(attempt)) {
        break;
      }
    } catch {
      // Ignore per-endpoint failures and continue to the next Google surface.
    }

    if (index < searchTargets.length - 1) {
      await wait(140);
    }
  }

  return attempts;
}
async function fetchDuckDuckGoAttempt(query: string, labelSuffix: string): Promise<SearchFetchResult | null> {
  const searchUrl = new URL(DUCKDUCKGO_SEARCH_URL);
  searchUrl.searchParams.set('q', query);
  searchUrl.searchParams.set('kl', 'us-en');

  try {
    return await fetchSearchHtml(searchUrl, `duckduckgo-html-${labelSuffix}`);
  } catch {
    return null;
  }
}

/**
 * Fetch from DuckDuckGo Lite (lite.duckduckgo.com/lite/).
 *
 * The Lite endpoint returns an intentionally minimal HTML table-based page
 * specifically designed for low-bandwidth / restricted clients. It is issued
 * as a POST form request and is significantly less likely to trigger bot-detection
 * or 429-blocking compared to html.duckduckgo.com, making it an ideal silent
 * escalation step when the standard HTML endpoint is blocked or yields few results.
 */
async function fetchDuckDuckGoLiteAttempt(query: string, labelSuffix: string): Promise<SearchFetchResult | null> {
  const body = new URLSearchParams();
  body.set('q', query);
  body.set('kl', 'us-en');

  try {
    const response = await fetch(DUCKDUCKGO_LITE_URL, {
      method: 'POST',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': DEFAULT_HEADERS['user-agent'],
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    return {
      label: `duckduckgo-lite-${labelSuffix}`,
      url: response.url || DUCKDUCKGO_LITE_URL,
      status: response.status,
      html: await response.text(),
    };
  } catch {
    return null;
  }
}

interface DuckDuckGoEvidence {
  attempts: SearchFetchResult[];
  liteAttempts: SearchFetchResult[];
  instantAnswer: { status: number; results: SearchFallbackResult[] } | null;
  results: SearchFallbackResult[];
  diagnostics: string[];
}

/**
 * Collect DuckDuckGo search evidence across three tiers in order of bot-resistance:
 *   Tier 1: html.duckduckgo.com/html/   (GET, rich HTML)
 *   Tier 2: lite.duckduckgo.com/lite/   (POST form, minimal HTML — escalated when Tier 1 is thin)
 *   Tier 3: api.duckduckgo.com          (JSON Instant Answer — fallback when both HTML tiers fail)
 *
 * Results from all successful tiers are merged and deduplicated.
 */
async function collectDuckDuckGoEvidence(queryVariants: string[]): Promise<DuckDuckGoEvidence> {
  // Tier 1: standard HTML endpoint
  const htmlAttemptResults = await Promise.all(
    queryVariants.map((variant, index) => fetchDuckDuckGoAttempt(variant, `q${index + 1}`))
  );
  const attempts = htmlAttemptResults.filter((a): a is SearchFetchResult => Boolean(a));
  const htmlResults = selectDistinctSearchResults(
    attempts.flatMap((a) => extractSearchResultsFromDuckDuckGoHtml(a.html)),
    MAX_RESULTS
  );

  // Tier 2: Lite endpoint — escalate when HTML results are sparse or zero
  let liteAttempts: SearchFetchResult[] = [];
  let liteResults: SearchFallbackResult[] = [];
  if (htmlResults.length < DUCKDUCKGO_LITE_ESCALATION_THRESHOLD) {
    const liteAttemptResults = await Promise.all(
      queryVariants.map((variant, index) => fetchDuckDuckGoLiteAttempt(variant, `q${index + 1}`))
    );
    liteAttempts = liteAttemptResults.filter((a): a is SearchFetchResult => Boolean(a));
    liteResults = selectDistinctSearchResults(
      liteAttempts.flatMap((a) => extractSearchResultsFromDuckDuckGoHtml(a.html)),
      MAX_RESULTS
    );
  }

  let mergedResults = selectDistinctSearchResults([...htmlResults, ...liteResults], MAX_RESULTS);

  // Tier 3: Instant Answer JSON API — last resort when both HTML tiers yield nothing
  let instantAnswer: DuckDuckGoEvidence['instantAnswer'] = null;
  if (mergedResults.length === 0) {
    instantAnswer = await fetchDuckDuckGoInstantAnswer(queryVariants[0] || '');
    if (instantAnswer && instantAnswer.results.length > 0) {
      mergedResults = selectDistinctSearchResults(
        [...mergedResults, ...instantAnswer.results],
        MAX_RESULTS
      );
    }
  }

  const diagnostics: string[] = [];
  if (attempts.length > 0) {
    diagnostics.push(...buildDiagnostics(attempts, htmlResults.length, 'duckduckgo'));
  } else {
    diagnostics.push('duckduckgo-html:fetch-failed');
  }
  if (liteAttempts.length > 0) {
    diagnostics.push(...liteAttempts.map((a) => `duckduckgo-lite-${a.label.split('-').pop()}:${a.status}`));
    diagnostics.push(`duckduckgo-lite-results:${liteResults.length}`);
  }
  if (instantAnswer) {
    diagnostics.push(`duckduckgo-instant:${instantAnswer.status}`);
    diagnostics.push(`duckduckgo-instant-results:${instantAnswer.results.length}`);
  }

  return { attempts, liteAttempts, instantAnswer, results: mergedResults, diagnostics };
}

async function fetchDuckDuckGoInstantAnswer(query: string): Promise<{ status: number; results: SearchFallbackResult[] } | null> {
  const endpoint = new URL(DUCKDUCKGO_INSTANT_ANSWER_URL);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('no_html', '1');
  endpoint.searchParams.set('skip_disambig', '1');

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'user-agent': DEFAULT_HEADERS['user-agent'],
      },
      signal: AbortSignal.timeout(15000),
    });

    const payload = await response.json();
    return {
      status: response.status,
      results: extractSearchResultsFromDuckDuckGoInstantAnswer(payload),
    };
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

function normalizeFallbackMode(candidate: unknown): SearchFallbackMode | null {
  return isSearchFallbackMode(candidate) ? candidate : null;
}

function isBlockedGoogleAttempt(attempt: SearchFetchResult): boolean {
  return attempt.status === 429 || isGoogleBlockedPage(attempt.html);
}

async function collectGoogleSearchEvidence(queryVariants: string[]): Promise<{
  attempts: SearchFetchResult[];
  aiOverview: string[];
  results: SearchFallbackResult[];
  allBlocked: boolean;
}> {
  const attempts: SearchFetchResult[] = [];
  let aiOverview: string[] = [];
  let results: SearchFallbackResult[] = [];
  const limitedVariants = queryVariants.slice(0, GOOGLE_QUERY_VARIANT_LIMIT);

  for (const [index, variant] of limitedVariants.entries()) {
    const variantAttempts = await fetchGoogleAttempts(variant, `q${index + 1}`);
    attempts.push(...variantAttempts);

    if (aiOverview.length === 0) {
      aiOverview = variantAttempts.flatMap((attempt) => extractAiOverview(attempt.html));
    }

    const variantResults = selectDistinctSearchResults(
      variantAttempts.flatMap((attempt) => extractSearchResultsFromGoogleHtml(attempt.html)),
      MAX_RESULTS
    );
    results = selectDistinctSearchResults([...results, ...variantResults], MAX_RESULTS);

    const variantFullyBlocked = variantAttempts.length > 0 && variantAttempts.every(isBlockedGoogleAttempt);
    if (aiOverview.length > 0 || results.length >= GOOGLE_RESULT_TARGET || variantFullyBlocked) {
      break;
    }

    if (index < limitedVariants.length - 1) {
      await wait(GOOGLE_VARIANT_DELAY_MS);
    }
  }

  return {
    attempts,
    aiOverview,
    results,
    allBlocked: attempts.length > 0 && attempts.every(isBlockedGoogleAttempt),
  };
}

export async function buildGoogleSearchFallbackPayload(
  query: string,
  mode: SearchFallbackMode = 'google_duckduckgo'
): Promise<SearchFallbackPayload> {
  if (mode === 'off') {
    throw new Error('Fallback search is disabled for this request.');
  }

  const queryVariants = buildSearchQueryVariants(query);
  const googleEvidence = mode === 'duckduckgo'
    ? null
    : await collectGoogleSearchEvidence(queryVariants);
  if (mode === 'duckduckgo') {
    const ddgEvidence = await collectDuckDuckGoEvidence(queryVariants);
    const { results: alternateResults, diagnostics } = ddgEvidence;

    if (alternateResults.length > 0) {
      return {
        query,
        mode,
        source: 'alternate-search-snippets',
        provider: 'duckduckgo',
        summary: buildSummary(query, [], alternateResults),
        aiOverview: [],
        results: alternateResults,
        extractedAt: Date.now(),
        diagnostics,
      };
    }

    throw new Error(`No extractable search snippets were available. ${diagnostics.join(' | ')}`);
  }

  const googleAttempts = googleEvidence?.attempts || [];
  const aiOverview = googleEvidence?.aiOverview || [];
  const googleResults = googleEvidence?.results || [];

  if (mode === 'google_duckduckgo') {
    const ddgEvidence = await collectDuckDuckGoEvidence(queryVariants);
    const { attempts: duckDuckGoAttempts, diagnostics: ddgDiagnostics } = ddgEvidence;
    const alternateResults = ddgEvidence.results;

    const blendedResults = selectDistinctSearchResults(
      interleaveSearchResults(googleResults, alternateResults),
      MAX_RESULTS
    );

    if (aiOverview.length > 0 || googleResults.length > 0) {
      const diagnostics = buildDiagnostics(googleAttempts, googleResults.length, 'google');
      diagnostics.push(...ddgDiagnostics);

      return {
        query,
        mode,
        source: aiOverview.length > 0 ? 'google-ai-overview' : 'google-search-snippets',
        provider: 'google',
        summary: buildSummary(query, aiOverview, blendedResults),
        aiOverview,
        results: blendedResults,
        extractedAt: Date.now(),
        diagnostics,
      };
    }

    if (alternateResults.length > 0) {
      const diagnostics = buildDiagnostics(googleAttempts, googleResults.length, 'google');
      diagnostics.push(...ddgDiagnostics);

      return {
        query,
        mode,
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
    diagnostics.push(...ddgDiagnostics);

    throw new Error(`No extractable search snippets were available. ${diagnostics.join(' | ')}`);
  }

  if (aiOverview.length > 0 || googleResults.length > 0) {
    return {
      query,
      mode,
      source: aiOverview.length > 0 ? 'google-ai-overview' : 'google-search-snippets',
      provider: 'google',
      summary: buildSummary(query, aiOverview, googleResults),
      aiOverview,
      results: googleResults,
      extractedAt: Date.now(),
      diagnostics: buildDiagnostics(googleAttempts, googleResults.length, 'google'),
    };
  }

  if (googleEvidence?.allBlocked) {
    throw new Error(
      `Google Search blocked automated extraction with 429 responses. ${buildDiagnostics(googleAttempts, googleResults.length, 'google').join(' | ')}`
    );
  }

  throw new Error(`No extractable search snippets were available. ${buildDiagnostics(googleAttempts, googleResults.length, 'google').join(' | ')}`);
}

function buildFallbackPopulation(payload: SearchFallbackPayload): WebPageGenotype[] {
  const searchUrl = buildSearchUrl(payload.query, payload.provider);
  const distinctResults = selectDistinctSearchResults(payload.results, MAX_RESULTS - 1);

  const overviewPage: WebPageGenotype = {
    id: `fallback-overview-${payload.extractedAt}`,
    url: searchUrl,
    title: buildFallbackOverviewTitle(payload),
    content: sanitizeFallbackSnippet(payload.summary),
    definitions: getRenderableDefinitions([
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
    ], 8),
    subTopics: getRenderableSubTopics(
      distinctResults.slice(0, 8).map((result) => ({
        title: result.title,
        summary: result.snippet,
        sourceUrl: result.url,
      }))
    ).slice(0, 8),
    informativeScore: scoreInformativeText(payload.summary),
    authorityScore: 0.82,
    fitness: 0,
  };

  const sourcePages = distinctResults.map((result, index) => ({
    id: `fallback-source-${index}-${payload.extractedAt}`,
    url: result.url,
    title: result.title,
    content: sanitizeFallbackSnippet(result.excerpt || result.snippet),
    definitions: getRenderableDefinitions([
      {
        term: deriveConceptLabel(result.title, payload.query),
        description: result.snippet,
        sourceUrl: result.url,
      },
    ], 4),
    subTopics: getRenderableSubTopics([
      {
        title: result.title,
        summary: result.snippet,
        sourceUrl: result.url,
      },
    ]).slice(0, 4),
    informativeScore: scoreInformativeText(result.snippet),
    authorityScore: scoreDomainAuthority(result.url),
    fitness: 0,
  }));

  return [overviewPage, ...sourcePages];
}

function calculateFitness(page: WebPageGenotype, optimalSet: WebPageGenotype[]): number {
  const currentTerms = new Set(
    optimalSet.flatMap((candidate) => (candidate.definitions || []).map((definition) => (definition.term || '').toLowerCase()))
  );
  const pageTerms = (page.definitions || []).map((definition) => (definition.term || '').toLowerCase());
  const overlap = pageTerms.filter((term) => term && currentTerms.has(term)).length;
  const redundancy = overlap / Math.max(pageTerms.length, 1);

  return (
    (LEGACY_EVOLUTION_WEIGHTS.alpha * page.informativeScore)
    + (LEGACY_EVOLUTION_WEIGHTS.beta * page.authorityScore)
    - (LEGACY_EVOLUTION_WEIGHTS.gamma * redundancy)
  );
}

function evolvePopulation(population: WebPageGenotype[], generations = 3): WebPageGenotype[] {
  const dedupedPopulation = population.filter((page, index) => (
    Boolean(page?.title?.trim())
    && Boolean(page?.content?.trim())
    && population.findIndex((candidate) => candidate.url === page.url) === index
  ));

  let currentPopulation = dedupedPopulation.map((page) => ({
    ...page,
    definitions: Array.isArray(page.definitions) ? page.definitions : [],
    subTopics: Array.isArray(page.subTopics) ? page.subTopics : [],
    fitness: Number.isFinite(page.fitness) ? page.fitness : 0,
  }));
  const targetPopulationSize = currentPopulation.length;

  if (targetPopulationSize <= 2) {
    return currentPopulation;
  }

  for (let generation = 0; generation < generations; generation += 1) {
    currentPopulation.forEach((page) => {
      page.fitness = calculateFitness(page, []);
    });

    currentPopulation.sort((left, right) => right.fitness - left.fitness);
    const survivors = currentPopulation.slice(0, Math.max(2, Math.ceil(targetPopulationSize / 2)));
    const nextPopulation = survivors.map((page) => ({ ...page }));
    let offspringIndex = 0;

    while (nextPopulation.length < targetPopulationSize && survivors.length > 0) {
      const parentA = survivors[offspringIndex % survivors.length];
      const parentB = survivors[(offspringIndex + generation + 1) % survivors.length] || parentA;

      nextPopulation.push({
        id: `legacy-offspring-${generation}-${offspringIndex}`,
        url: 'hybrid-source',
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: `${parentA.content.substring(0, 500)} ${parentB.content.substring(0, 500)}`.trim(),
        definitions: getRenderableDefinitions([
          ...(parentA.definitions || []).slice(0, 4),
          ...(parentB.definitions || []).slice(0, 4),
        ], 8),
        subTopics: getRenderableSubTopics([
          ...(parentA.subTopics || []).slice(0, 4),
          ...(parentB.subTopics || []).slice(0, 4),
        ]).slice(0, 8),
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0,
      });

      offspringIndex += 1;
    }

    currentPopulation = nextPopulation.slice(0, targetPopulationSize);
  }

  currentPopulation.forEach((page) => {
    page.fitness = calculateFitness(page, []);
  });
  currentPopulation.sort((left, right) => right.fitness - left.fitness);

  return currentPopulation;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function parseRequestPayload(rawBody: string): RequestPayload {
  if (!rawBody.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (Array.isArray(parsed)) {
      return {
        // Older legacy clients can post the evolve population as a bare JSON array.
        population: parsed,
      };
    }

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as RequestPayload
      : {};
  } catch {
    return {};
  }
}

export function extractRequestedFallbackMode(
  requestUrl: URL,
  payload: RequestPayload
): SearchFallbackMode {
  return normalizeFallbackMode(requestUrl.searchParams.get('mode'))
    || normalizeFallbackMode(typeof payload.mode === 'string' ? payload.mode : undefined)
    || normalizeFallbackMode(typeof payload.fallbackMode === 'string' ? payload.fallbackMode : undefined)
    || normalizeFallbackMode(requestUrl.searchParams.get('provider'))
    || normalizeFallbackMode(payload.provider)
    || normalizeFallbackMode(payload.fallbackProvider)
    || 'google_duckduckgo';
}

function extractQuery(requestUrl: URL, payload: RequestPayload): string {
  const candidates = [
    requestUrl.searchParams.get('query'),
    typeof payload.query === 'string' ? payload.query : undefined,
    typeof payload.topic === 'string' ? payload.topic : undefined,
    typeof payload.searchQuery === 'string' ? payload.searchQuery : undefined,
    typeof payload.prompt === 'string' ? payload.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function normalizePopulationPayload(payload: RequestPayload): WebPageGenotype[] {
  const candidateList = Array.isArray(payload.population)
    ? payload.population
    : Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.pages)
        ? payload.pages
        : [];

  return candidateList.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }

    const page = candidate as Partial<WebPageGenotype>;
    if (typeof page.title !== 'string' || typeof page.content !== 'string' || typeof page.url !== 'string') {
      return [];
    }

    return [{
      id: typeof page.id === 'string' && page.id.trim() ? page.id : `legacy-page-${index}`,
      url: page.url,
      title: page.title,
      content: page.content,
      definitions: Array.isArray(page.definitions) ? page.definitions : [],
      subTopics: Array.isArray(page.subTopics) ? page.subTopics : [],
      informativeScore: Number.isFinite(page.informativeScore) ? page.informativeScore : scoreInformativeText(page.content),
      authorityScore: Number.isFinite(page.authorityScore) ? page.authorityScore : scoreDomainAuthority(page.url),
      fitness: Number.isFinite(page.fitness) ? page.fitness : 0,
    }];
  });
}

async function handleSearchFallbackRequest(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const payload = request.method === 'POST'
    ? parseRequestPayload(await readRequestBody(request))
    : {};
  const query = extractQuery(requestUrl, payload);
  const fallbackMode = extractRequestedFallbackMode(requestUrl, payload);

  if (!query) {
    sendJson(response, 400, { error: 'Query is required' });
    return;
  }

  if (fallbackMode === 'off') {
    sendJson(response, 400, { error: 'Fallback search is disabled for this request.' });
    return;
  }

  try {
    const fallbackPayload = await buildGoogleSearchFallbackPayload(query, fallbackMode);
    sendJson(response, 200, fallbackPayload);
  } catch (error) {
    console.error('Search fallback failed', error);
    const message = error instanceof Error ? error.message : 'Unable to extract search fallback results at the moment.';
    sendJson(response, 502, { error: message });
  }
}

async function handleLegacySearchRequest(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const payload = request.method === 'POST'
    ? parseRequestPayload(await readRequestBody(request))
    : {};
  const query = extractQuery(requestUrl, payload);
  const fallbackMode = extractRequestedFallbackMode(requestUrl, payload);

  if (!query) {
    sendJson(response, 400, { error: 'Query is required' });
    return;
  }

  if (fallbackMode === 'off') {
    sendJson(response, 400, { error: 'Fallback search is disabled for this request.' });
    return;
  }

  try {
    const fallbackPayload = await buildGoogleSearchFallbackPayload(query, fallbackMode);
    const population = buildFallbackPopulation(fallbackPayload);
    const groundingChunks = mapFallbackArtifacts(fallbackPayload);

    sendJson(response, 200, {
      query,
      results: population,
      population,
      artifacts: {
        groundingChunks,
        searchSummary: fallbackPayload.summary,
      },
      rawSearchResults: groundingChunks,
      searchSummary: fallbackPayload.summary,
      sourceMode: 'search-fallback',
      fallbackSource: fallbackPayload.source,
      fallbackPayload,
      generationNote: 'Legacy /api/search route is being served by the live fallback search compatibility layer.',
    });
  } catch (error) {
    console.error('Legacy /api/search compatibility route failed', error);
    const message = error instanceof Error ? error.message : 'Search compatibility route failed.';
    sendJson(response, 502, { error: message });
  }
}

async function handleLegacyEvolveRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const payload = parseRequestPayload(await readRequestBody(request));
  const population = normalizePopulationPayload(payload);

  if (population.length === 0) {
    sendJson(response, 400, { error: 'Population is required' });
    return;
  }

  const generationsValue = payload.generations ?? payload.generationCount;
  const generations = typeof generationsValue === 'number' && Number.isFinite(generationsValue)
    ? Math.max(1, Math.min(6, Math.floor(generationsValue)))
    : 3;
  const evolvedPopulation = evolvePopulation(population, generations);

  sendJson(response, 200, {
    results: evolvedPopulation,
    population: evolvedPopulation,
    generation: generations,
    bestFitness: evolvedPopulation[0]?.fitness || 0,
    artifacts: {
      evolvedPopulation,
    },
  });
}

function createApiCompatibilityMiddleware() {
  return async (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    if (!request.url) {
      next();
      return;
    }

    const requestUrl = new URL(request.url, 'http://localhost');
    if (
      requestUrl.pathname !== SEARCH_FALLBACK_ROUTE
      && requestUrl.pathname !== SEARCH_ROUTE
      && requestUrl.pathname !== EVOLVE_ROUTE
    ) {
      next();
      return;
    }

    try {
      if (requestUrl.pathname === SEARCH_FALLBACK_ROUTE) {
        await handleSearchFallbackRequest(request, response, requestUrl);
        return;
      }

      if (requestUrl.pathname === SEARCH_ROUTE) {
        await handleLegacySearchRequest(request, response, requestUrl);
        return;
      }

      if (requestUrl.pathname === EVOLVE_ROUTE) {
        await handleLegacyEvolveRequest(request, response);
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function googleSearchFallbackPlugin(): Plugin {
  const middleware = createApiCompatibilityMiddleware();

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
