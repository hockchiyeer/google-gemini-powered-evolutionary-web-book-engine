import assert from 'node:assert/strict';
import {
  PAGE_EXCERPT_MAX_CHARS,
  decodeHtmlBytes,
  enrichResultsWithPageExcerpts,
  extractReadableText,
  isFetchablePageUrl,
} from '../../server/searchStrategies/pageExcerpt.ts';
import { buildGoogleSearchFallbackPayload } from '../../server/googleSearchFallback.ts';
import { extractDefinitionsFromSentences, synthesizeFallbackWebBook } from '../../src/services/evolutionService.ts';
import { isPageChromeText } from '../../src/utils/webBookRender.ts';
import { countWords } from '../../src/services/searchFallbackShared.ts';
import type { SearchFallbackResult } from '../../src/types.ts';

const ARTICLE = `<html><head><title>Persatuan Bahasa Cina Universiti Malaya</title><style>p{color:red}</style></head><body>
<nav><ul><li>Home</li><li>About us</li><li>Contact</li></ul></nav>
<div class="cookie">We use cookies to improve your experience on this site and for analytics purposes only.</div>
<main>
<p>Completely unrelated lead-in paragraph about gardening tools, soil mixtures and the best time of the year to plant tomatoes.</p>
<h1>Persatuan Bahasa Cina Universiti Malaya</h1>
<p>Persatuan Bahasa Cina Universiti Malaya (PBCUM) is the largest Chinese student society on the Universiti Malaya campus, founded in 1962.</p>
<p>The society organises cultural festivals, literary talks and publishes a student journal every year, bringing together members of every faculty.</p>
<p>Share on Facebook Share on Twitter Share on LinkedIn</p>
<p>Staff View Cite this Text this Email this Export Record Export to RefWorks Export to EndNoteWeb Save to List</p>
<ul><li>Tel: 03-7967 5650 Fax: 03-7967 5651</li></ul>
</main>
<footer><p>Copyright 2026 University of Malaya. All rights reserved by the faculty administration office.</p></footer>
</body></html>`;

// 1. Readable text: body paragraphs stay; menus, cookie notices, share bars, catalogue chrome, footers and off-topic paragraphs go.
{
  const text = extractReadableText(ARTICLE, ['Persatuan Bahasa Cina Universiti Malaya']);
  assert.match(text, /largest Chinese student society/);
  assert.match(text, /literary talks and publishes a student journal/);
  assert.doesNotMatch(text, /cookies|Share on Facebook|Staff View|Export Record|Tel:|All rights reserved|gardening|About us/i);
  assert.equal(text.split('\n\n').length, 2);
  assert.ok(text.length <= PAGE_EXCERPT_MAX_CHARS);
  // Without a topic every readable paragraph is kept (nothing to judge relevance by); a page that never mentions the topic yields nothing.
  assert.match(extractReadableText(ARTICLE), /gardening/);
  assert.equal(extractReadableText(ARTICLE, ['quantum chromodynamics']), '');
}

// 2. Chinese pages are matched by character pairs, so a Chinese topic finds its Chinese body paragraphs.
{
  const html = '<main><p>The weather forecast for tomorrow includes scattered showers across the northern states of the peninsula.</p><p>马来亚大学华文学会于1962年创立，是马大规模最大的华人学生组织，致力于推广华文与中华文化。</p></main>';
  const text = extractReadableText(html, ['马来亚大学华文学会']);
  assert.match(text, /1962年创立/);
  assert.doesNotMatch(text, /weather forecast/);
}

// 3. Page chrome detection: the two junk lines from the offline sample books, plus ordinary sentences that must survive.
{
  assert.equal(isPageChromeText('13,677 followers · 60 talking about this.'), true);
  assert.equal(isPageChromeText('Staff View Cite this Text this Email this Export Record Export to RefWorks Export to EndNoteWeb Export to EndNote Save to List'), true);
  assert.equal(isPageChromeText('Contact Info: Department of Chinese Studies Faculty of Arts and Social Sciences Tel: (603)-7967 5650'), true);
  assert.equal(isPageChromeText('This link opens in a new window'), true);
  assert.equal(isPageChromeText('Home About Us Our Team News Events Gallery Downloads Careers Partners Donate'), true);
  assert.equal(isPageChromeText('学会于 1962 年创立于马来亚大学，为目前所掌握资料中唯一明确记载创立年份的来源。'), false);
  assert.equal(isPageChromeText('The society has 13,677 members and organises festivals every year.'), false);
  assert.equal(isPageChromeText('The Department of Chinese Studies was established in 1963 and is the oldest in Malaysia.'), false);
}

// 4. Which URLs may be fetched.
{
  assert.equal(isFetchablePageUrl('https://en.wikipedia.org/wiki/University_of_Malaya'), true);
  assert.equal(isFetchablePageUrl('http://pbcum.com/about'), true);
  for (const blocked of [
    'http://localhost:3000/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://192.168.0.5/x', 'http://172.20.1.1/x',
    'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'ftp://example.org/x', 'file:///etc/passwd',
    'https://www.facebook.com/pbcum', 'https://m.facebook.com/pbcum', 'https://www.scribd.com/document/1', 'https://example.org/report.pdf',
  ]) assert.equal(isFetchablePageUrl(blocked), false, `${blocked} must not be fetched`);
  assert.equal(isFetchablePageUrl('https://fcbarcelona.com/en'), true);
}

// 5. Enrichment adds body text, keeps snippets for unreadable pages, reads one page per host and never throws.
{
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes('slow')) throw new Error('timeout');
    if (url.includes('missing')) return new Response('nope', { status: 404 });
    if (url.includes('image')) return new Response('x', { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response(ARTICLE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const results: SearchFallbackResult[] = [
    { title: 'Persatuan Bahasa Cina UM', url: 'https://pbcum.com/about', snippet: 'Snippet one about the society.' },
    { title: 'Same host again', url: 'https://pbcum.com/history', snippet: 'Snippet two about the society.' },
    { title: 'Facebook page', url: 'https://www.facebook.com/pbcum', snippet: 'Snippet three about the society.' },
    { title: 'Slow page', url: 'https://slow.example.org/a', snippet: 'Snippet four about the society.' },
    { title: 'Missing page', url: 'https://missing.example.org/a', snippet: 'Snippet five about the society.' },
    { title: 'Image page', url: 'https://image.example.org/a', snippet: 'Snippet six about the society.' },
    { title: 'Another readable page', url: 'https://um.edu.my/pbcum', snippet: 'Snippet seven about the society.' },
  ];
  const enriched = await enrichResultsWithPageExcerpts(results, 'Persatuan Bahasa Cina Universiti Malaya', { fetchImpl, totalBudgetMs: 5000 });
  assert.equal(enriched.length, results.length, 'no result may be dropped');
  assert.deepEqual(enriched.map((r) => r.snippet), results.map((r) => r.snippet), 'snippets are untouched');
  assert.match(enriched[0].excerpt || '', /largest Chinese student society/);
  assert.equal(enriched[1].excerpt, undefined, 'a second page of an already-read host is not fetched');
  assert.equal(enriched[2].excerpt, undefined, 'login-walled hosts are not fetched');
  assert.equal(enriched[3].excerpt, undefined);
  assert.equal(enriched[4].excerpt, undefined);
  assert.equal(enriched[5].excerpt, undefined);
  assert.match(enriched[6].excerpt || '', /literary talks/);
  assert.ok(!calls.some((url) => url.includes('facebook.com')) && !calls.includes('https://pbcum.com/history'));
  assert.equal(results[0].excerpt, undefined, 'input results are not mutated');
}

// 6. Declared charsets are honoured (GBK / Big5 pages are common for Chinese sources).
{
  const gbk = Uint8Array.from([0xc2, 0xed, 0xc0, 0xb4, 0xd1, 0xc7]); // 马来亚 in GBK
  assert.equal(decodeHtmlBytes(gbk, 'text/html; charset=gbk'), '马来亚');
  assert.equal(decodeHtmlBytes(new TextEncoder().encode('<p>马来亚</p>'), 'text/html'), '<p>马来亚</p>');
  assert.equal(decodeHtmlBytes(new TextEncoder().encode('ok'), 'text/html; charset=bogus-charset'), 'ok');
}

// 7. The search payload carries page excerpts (and says so), unless page reading is switched off.
{
  const globals = globalThis as unknown as { fetch: unknown };
  const originalFetch = globals.fetch;
  const DDG = `<html><body>
<a class="result__a" href="https://pbcum.example.org/about">Persatuan Bahasa Cina Universiti Malaya (PBCUM) society profile</a>
<a class="result__snippet">Persatuan Bahasa Cina Universiti Malaya is a Chinese student society at the university.</a>
<a class="result__a" href="https://other.example.net/b">Chinese student societies in Malaysian universities</a>
<a class="result__snippet">Chinese student societies in Malaysian universities organise cultural festivals and literary talks.</a>
</body></html>`;
  globals.fetch = async (input: unknown) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input);
    if (/duckduckgo\.com/.test(url)) return new Response(DDG, { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://pbcum.example.org/')) return new Response(ARTICLE, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  };
  try {
    const withPages = await buildGoogleSearchFallbackPayload('Persatuan Bahasa Cina Universiti Malaya', 'duckduckgo');
    assert.match(withPages.results[0].excerpt || '', /literary talks/);
    assert.ok(withPages.diagnostics?.some((d) => /^page-excerpts:[12]\/2$/.test(d)), String(withPages.diagnostics));

    const withoutPages = await buildGoogleSearchFallbackPayload('Persatuan Bahasa Cina Universiti Malaya', 'duckduckgo', { readPages: false });
    assert.equal(withoutPages.results[0].excerpt, undefined);
  } finally {
    globals.fetch = originalFetch;
  }
}

// 8. Definitions come from English, Malay and Chinese defining sentences, once per term, and never from chrome.
{
  const defs = extractDefinitionsFromSentences([
    'Persatuan Bahasa Cina Universiti Malaya ialah salah satu organisasi pelajar di Universiti Malaya yang memartabatkan budaya Cina.',
    'The Department of Chinese Studies is the oldest Chinese Studies department in Malaysia, founded in 1963.',
    '马大华文学会是马大规模最大的华人学生组织，致力于推广华文与中华文化。',
    'Objective: to preserve, teach and promote Chinese culture across the campus community.',
    'Objective: a duplicate term that must not be listed twice in the same page.',
  ], 'https://example.org/x', 4);
  assert.ok(defs.length >= 3, `expected at least 3 definitions, got ${defs.map((d) => d.term).join(' | ')}`);
  assert.ok(defs.some((d) => /Persatuan Bahasa Cina/.test(d.term)));
  assert.ok(defs.some((d) => d.term === '马大华文学会'));
  assert.equal(defs.filter((d) => d.term === 'Objective').length, 1);
  assert.ok(defs.every((d) => d.sourceUrl === 'https://example.org/x'));
  assert.equal(extractDefinitionsFromSentences(['The sky was clear and the evening was quiet across the valley today.'], 'u').length, 0);
}

// 9. The book: page chrome never reaches a chapter; a thin pool gives fewer, fuller chapters; a rich pool gives six real ones.
{
  const page = (n: number, content: string) => ({
    id: `p-${n}`, title: `Source ${n}`, url: `https://site-${n}.example.org/a`, content,
    definitions: [], subTopics: [], informativeScore: 0.9, authorityScore: 0.9, fitness: 0,
  });

  const thin = synthesizeFallbackWebBook('Persatuan Bahasa Cina Universiti Malaya', [
    page(1, 'Persatuan Bahasa Cina Universiti Malaya is a Chinese student society founded in 1962. 13,677 followers · 60 talking about this.'),
    page(2, 'Staff View Cite this Text this Email this Export Record Export to RefWorks Export to EndNoteWeb Save to List. The society publishes a literary journal each year.'),
    page(3, 'Activities include cultural festivals, literary talks and charity drives for rare disease patients. Members come from every faculty of the university.'),
  ] as any);
  const thinText = thin.chapters.map((c) => c.content).join('\n');
  assert.doesNotMatch(thinText, /followers|Staff View|Export Record|talking about this/i);
  assert.equal(thin.chapters.length, 2, 'four real sentences make two two-sentence chapters, not four one-line ones');
  for (const chapter of thin.chapters) {
    assert.ok(chapter.content.split(/(?<=[.!?])\s+/).length >= 2, `chapter "${chapter.title}" must hold at least two sentences`);
  }
  assert.notEqual(thin.chapters[0].title, thin.chapters[1].title);

  // 8 sources x 12 genuinely different sentences (the engine drops near-identical ones, as it should).
  const subjects = ['The calligraphy workshop', 'The debate team', 'The alumni network', 'The annual dinner', 'The lion dance troupe', 'The newsletter', 'The library collection', 'The charity drive', 'The orientation camp', 'The scholarship fund', 'The drama production', 'The language clinic'];
  const verbs = ['attracts first-year students from several faculties every semester', 'was revived by a committee that wrote down its rules in detail', 'relies on volunteers who coordinate venues and equipment weeks ahead', 'raised funds that were distributed to local community groups last year', 'trains participants through weekly sessions led by senior members', 'documents its history in printed booklets kept in the society office', 'partners with lecturers from the department of Chinese studies on projects', 'receives feedback through surveys that the committee reviews each term'];
  const sentenceFor = (n: number, i: number) => `${subjects[i % subjects.length]} of source ${n} ${verbs[(n + i) % verbs.length]}.`;
  const body = (n: number) => `${Array.from({ length: 6 }, (_, i) => sentenceFor(n, i)).join(' ')}\n\n${Array.from({ length: 6 }, (_, i) => sentenceFor(n, i + 6)).join(' ')}`;
  const rich = synthesizeFallbackWebBook('Persatuan Bahasa Cina Universiti Malaya', Array.from({ length: 8 }, (_, i) => page(i + 1, body(i + 1))) as any);
  assert.equal(rich.chapters.length, 6);
  for (const chapter of rich.chapters) {
    assert.ok(countWords(chapter.content) >= 120, `chapter "${chapter.title}" has only ${countWords(chapter.content)} words`);
  }
  const allSentences = rich.chapters.flatMap((c) => c.content.split(/(?<=[.!?])\s+/));
  assert.equal(new Set(allSentences).size, allSentences.length, 'no sentence repeats across chapters');
}

console.log('offlineBookDepth tests passed');
