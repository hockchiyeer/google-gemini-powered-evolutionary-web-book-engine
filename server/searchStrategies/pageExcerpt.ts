import type { SearchFallbackResult } from '../../src/types.ts';
import { containsPoisonBoilerplate, isPageChromeText } from '../../src/utils/webBookRender.ts';
import { CJK_CHAR_GLOBAL_PATTERN, calculateTextSimilarity } from '../../src/services/searchFallbackShared.ts';
import { collapseWhitespace, decodeHtmlEntities } from './shared.ts';

/**
 * Search-result snippets are one to three sentences long, so a Web-book written from them alone (no Gemini key) comes out
 * as a handful of sentences per chapter. This module reads the result pages themselves and keeps their readable body
 * paragraphs as `excerpt`, which is what gives the offline book real chapter text.
 */

export const PAGE_FETCH_MAX_PAGES = 10;
export const PAGE_FETCH_CONCURRENCY = 4;
export const PAGE_FETCH_TIMEOUT_MS = 6000;
export const PAGE_FETCH_TOTAL_BUDGET_MS = 14000;
export const PAGE_FETCH_MAX_BYTES = 1_500_000;
export const PAGE_EXCERPT_MAX_CHARS = 3200;
const MAX_PARAGRAPHS_PER_PAGE = 8;
const MIN_PARAGRAPH_LATIN_CHARS = 70;
const MIN_PARAGRAPH_CJK_CHARS = 28;

// Sites that serve a login wall or a script-only shell to a plain HTTP client: fetching them only yields page chrome.
const UNREADABLE_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'youtube.com',
  'youtu.be', 'pinterest.com', 'reddit.com', 'scribd.com', 'quora.com', 'threads.net', 'weibo.com',
];
const UNREADABLE_EXTENSION = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|svg|mp[34]|avi|mov)(?:$|[?#])/i;

export type PageFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface PageExcerptOptions {
  fetchImpl?: PageFetch;
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  totalBudgetMs?: number;
  maxBytes?: number;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** True for public http(s) pages a plain GET can read; false for private addresses, login-walled sites and binary files. */
export function isFetchablePageUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (isPrivateHost(host)) return false;
    if (UNREADABLE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
    if (UNREADABLE_EXTENSION.test(url.pathname + url.search)) return false;
    return true;
  } catch {
    return false;
  }
}

function sniffCharset(contentType: string | null, head: string): string {
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] || head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  return (fromHeader || fromMeta || 'utf-8').toLowerCase();
}

/** Decodes a response body with the charset it declares (GBK and Big5 pages are common for Chinese sources). */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const charset = sniffCharset(contentType, head);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function pickMainRegion(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside|button|select|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const region = stripped.match(/<(article|main)\b[\s\S]*?<\/\1>/i)
    || stripped.match(/<div[^>]+(?:id|class)=["'][^"']*(?:mw-content-text|post-content|entry-content|article-body|article-content|main-content|content-body)[^"']*["'][\s\S]*/i);
  return region ? region[0] : stripped;
}

function cleanBlockText(block: string): string {
  return collapseWhitespace(decodeHtmlEntities(block.replace(/<[^>]+>/g, ' ')))
    .replace(/\[\s*(?:\d+|edit|citation needed|note \d+)\s*\]/gi, '')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .trim();
}

function paragraphsOf(region: string): string[] {
  return [...region.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => cleanBlockText(match[2]));
}

/**
 * Many site builders (Wix, Elementor, hand-made pages) put text in <div>/<span>/<td>/<h*> instead of <p>. Leaf blocks
 * (no nested tags) of that kind are used when the page has too few <p> paragraphs.
 */
function leafBlocksOf(region: string): string[] {
  return [...region.matchAll(/<(div|span|td|section|h[1-6])\b[^>]*>([^<]{40,})<\/\1>/gi)].map((match) => cleanBlockText(match[2]));
}

/** The page's own summary (meta / Open Graph description): a readable few sentences even when the body is script-rendered. */
function metaDescriptionOf(html: string): string {
  const tag = html.match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)?.[0] || '';
  const content = tag.match(/content=["']([^"']+)["']/i)?.[1] || '';
  return cleanBlockText(content);
}

function queryTerms(...texts: string[]): { words: string[]; bigrams: string[] } {
  const words = new Set<string>();
  const bigrams = new Set<string>();
  for (const text of texts) {
    (text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).forEach((word) => words.add(word));
    for (const run of text.match(/[㐀-鿿豈-﫿]+/g) || []) {
      for (let index = 0; index + 1 < run.length; index += 1) bigrams.add(run.slice(index, index + 2));
    }
  }
  return { words: [...words], bigrams: [...bigrams] };
}

function isReadableParagraph(paragraph: string): boolean {
  const cjk = (paragraph.match(CJK_CHAR_GLOBAL_PATTERN) || []).length;
  const long = cjk >= MIN_PARAGRAPH_CJK_CHARS || (cjk === 0 && paragraph.length >= MIN_PARAGRAPH_LATIN_CHARS)
    || (cjk > 0 && paragraph.length >= MIN_PARAGRAPH_LATIN_CHARS * 1.5);
  if (!long) return false;
  if (isPageChromeText(paragraph) || containsPoisonBoilerplate(paragraph)) return false;
  // Link lists and menus: mostly short capitalised fragments with almost no sentence punctuation.
  const sentenceMarks = (paragraph.match(/[.!?。！？;；]/g) || []).length;
  return sentenceMarks >= 1 || paragraph.length >= 160;
}

/**
 * Readable body text of an HTML page: the main/article region's paragraphs, minus menus, cookie notices and other page
 * chrome. When `relevantTo` is given, the text starts at the first paragraph that mentions what was searched for (so
 * a page's unrelated lead-in is skipped) and a page that never mentions it yields nothing. Later paragraphs are kept
 * even when they say "the society" instead of repeating the name: they belong to the same article.
 */
export function extractReadableText(html: string, relevantTo: string[] = [], maxChars = PAGE_EXCERPT_MAX_CHARS): string {
  const terms = queryTerms(...relevantTo);
  const hasTerms = terms.words.length + terms.bigrams.length > 0;
  const isRelevant = (paragraph: string): boolean => {
    const lowered = paragraph.toLowerCase();
    return terms.words.some((word) => lowered.includes(word)) || terms.bigrams.some((pair) => paragraph.includes(pair));
  };

  const region = pickMainRegion(html);
  let candidates = paragraphsOf(region);
  if (candidates.filter(isReadableParagraph).length < 2) candidates = [...candidates, ...leafBlocksOf(region)];
  if (candidates.filter(isReadableParagraph).length === 0) candidates = [metaDescriptionOf(html)];
  const readable = candidates.filter(isReadableParagraph);
  const start = hasTerms ? readable.findIndex(isRelevant) : 0;
  if (start < 0) return '';

  const kept: string[] = [];
  let length = 0;
  for (const paragraph of readable.slice(start)) {
    if (kept.length >= MAX_PARAGRAPHS_PER_PAGE || length >= maxChars) break;
    if (kept.some((existing) => existing === paragraph || calculateTextSimilarity(existing, paragraph) >= 0.85)) continue;
    const clipped = paragraph.length > 900 ? `${paragraph.slice(0, 900).replace(/\s+\S*$/, '')}…` : paragraph;
    kept.push(clipped);
    length += clipped.length;
  }
  return kept.join('\n\n').slice(0, maxChars);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
}

async function fetchExcerpt(result: SearchFallbackResult, query: string, options: Required<PageExcerptOptions>, deadline: number): Promise<string> {
  const remaining = deadline - Date.now();
  if (remaining <= 250) return '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, remaining));
  try {
    const response = await options.fetchImpl(result.url, {
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,ms;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const contentType = response.headers.get('content-type');
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) return '';
    const html = decodeHtmlBytes(await readBounded(response, options.maxBytes), contentType);
    return extractReadableText(html, [query, result.title]);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Adds the readable body text of the first result pages as `excerpt`. Never throws and never drops a result: a page that
 * cannot be read (blocked, slow, binary, off-topic) keeps its snippet, so this can only add evidence.
 */
export async function enrichResultsWithPageExcerpts(
  results: ReadonlyArray<SearchFallbackResult>,
  query: string,
  overrides: PageExcerptOptions = {}
): Promise<SearchFallbackResult[]> {
  const options: Required<PageExcerptOptions> = {
    fetchImpl: overrides.fetchImpl || ((url, init) => fetch(url, init)),
    maxPages: overrides.maxPages ?? PAGE_FETCH_MAX_PAGES,
    concurrency: overrides.concurrency ?? PAGE_FETCH_CONCURRENCY,
    timeoutMs: overrides.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS,
    totalBudgetMs: overrides.totalBudgetMs ?? PAGE_FETCH_TOTAL_BUDGET_MS,
    maxBytes: overrides.maxBytes ?? PAGE_FETCH_MAX_BYTES,
  };

  const enriched = results.map((result) => ({ ...result }));
  const targets = enriched
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.excerpt && isFetchablePageUrl(result.url))
    // One page per host first, so a single site's many results cannot use up the whole fetch allowance.
    .filter(({ result }, position, all) => all.findIndex((other) => new URL(other.result.url).hostname === new URL(result.url).hostname) === position)
    .slice(0, options.maxPages);

  const deadline = Date.now() + options.totalBudgetMs;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const { result } = targets[next++];
      const excerpt = await fetchExcerpt(result, query, options, deadline);
      if (excerpt) result.excerpt = excerpt;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, targets.length) }, worker));
  return enriched;
}
