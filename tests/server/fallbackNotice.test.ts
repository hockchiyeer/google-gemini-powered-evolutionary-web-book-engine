import assert from 'node:assert/strict';
import { buildGoogleSearchFallbackPayload } from '../../server/googleSearchFallback.ts';
import { searchAndExtract } from '../../src/services/evolutionService.ts';
import {
  describeFallbackEvidence,
  getFallbackResultCount,
  isSyntheticFallbackPayload,
} from '../../src/services/searchFallbackShared.ts';
import type { SearchFallbackMode, SearchFallbackPayload } from '../../src/types.ts';

process.env.GEMINI_API_KEY = 'test-key';
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' } };
const realSetTimeout = globalThis.setTimeout;
globals.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as unknown as typeof setTimeout;
console.warn = () => {};
console.error = () => {};

const QUERY = 'Which candidate will win the Taipei mayor election due on Nov 2026?';
const MODEL = 'gemini-3-flash-preview';

const GOOGLE_BLOCKED = '<html><body>Our systems have detected unusual traffic from your computer network. captcha</body></html>';
const GOOGLE_OK = `<html><body>
<a href="https://news.example.org/taipei-race"><h3>Taipei mayoral race: candidates and polls</h3></a>
<div class="VwiC3b">The Taipei mayoral race features several declared candidates, and recent polls show a tight contest.</div>
<a href="https://wiki.example.org/taipei-election"><h3>2026 Taipei mayoral election overview</h3></a>
<div class="VwiC3b">An overview of the 2026 Taipei mayoral election, its candidates, parties and voting rules.</div>
</body></html>`;
const DDG_OK = `<html><body>
<a class="result__a" href="https://ddg-source.example.net/a">Taipei election analysis from DDG</a>
<a class="result__snippet">Analysis of the Taipei mayoral election with polling averages and candidate backgrounds.</a>
<a class="result__a" href="https://ddg-other.example.net/b">Taipei candidate profiles from DDG</a>
<a class="result__snippet">Profiles of the Taipei mayoral candidates including party platforms and past records.</a>
</body></html>`;
const EMPTY = '<html><body>nothing</body></html>';

type Scenario = { google: 'ok' | 'blocked' | 'empty'; ddg: 'ok' | 'empty'; gemini: 429 | 401 | 200 };
let scenario: Scenario = { google: 'ok', ddg: 'ok', gemini: 429 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

globals.fetch = async (input: unknown) => {
  const url = new URL(typeof input === 'string' ? input : (input as { url?: string }).url ?? String(input));
  if (url.hostname === 'localhost') {
    const payload = await buildGoogleSearchFallbackPayload(url.searchParams.get('query')!, url.searchParams.get('mode') as SearchFallbackMode);
    return json(payload);
  }
  if (url.hostname.endsWith('googleapis.com')) {
    if (scenario.gemini === 429) return json({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (scenario.gemini === 401) return json({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }, 401);
    return json({ candidates: [{ content: { parts: [{ text: '[]' }] } }] });
  }
  if (url.hostname.includes('google.com')) {
    return html(scenario.google === 'ok' ? GOOGLE_OK : scenario.google === 'blocked' ? GOOGLE_BLOCKED : EMPTY);
  }
  if (url.hostname === 'api.duckduckgo.com') return json({});
  if (url.hostname.includes('duckduckgo.com')) return html(scenario.ddg === 'ok' ? DDG_OK : EMPTY);
  return html(EMPTY, 404);
};

async function run(next: Scenario, mode: SearchFallbackMode = 'google_duckduckgo') {
  scenario = next;
  return searchAndExtract(QUERY, { mode, geminiModel: MODEL });
}

async function stopMessage(next: Scenario, mode: SearchFallbackMode = 'google_duckduckgo'): Promise<string> {
  try {
    await run(next, mode);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail('Expected searchAndExtract to stop with an error');
}

// A. Both providers contributed -> notice names both, source reflects both.
{
  const result = await run({ google: 'ok', ddg: 'ok', gemini: 429 });
  assert.equal(
    result.generationNote,
    `Selected Gemini model (${MODEL}) unavailable (usage limit reached); gathered evidence via Google fallback + DuckDuckGo fallback.`
  );
  assert.equal(result.fallbackSource, 'google_duckduckgo');
  assert.equal(result.fallbackReason, 'quota_exhausted');
  assert.equal(result.sourceMode, 'fallback_search');
  assert.ok(result.results.length >= 4);
}

// B. Google blocked -> DuckDuckGo only, and the notice says Google was tried but contributed nothing.
{
  const result = await run({ google: 'blocked', ddg: 'ok', gemini: 429 });
  assert.equal(
    result.generationNote,
    `Selected Gemini model (${MODEL}) unavailable (usage limit reached); gathered evidence via DuckDuckGo fallback (Google contributed no results).`
  );
  assert.equal(result.fallbackSource, 'duckduckgo');
}

// C. Neither provider returned anything -> graceful stop (no placeholder book), with retry/refine guidance.
{
  const message = await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 });
  assert.match(message, /^Search stopped: The Google and DuckDuckGo fallback searches returned no live results/);
  assert.ok(message.includes(QUERY), 'message keeps the exact query so the user can see what was searched');
  assert.match(message, /Search again with the same wording/);
  assert.match(message, /Refine the wording/);
  assert.match(message, /No Web-book was generated/);
  assert.doesNotMatch(message, /wikipedia/i);
  // useWebBookEngine rewrites messages containing quota/429/RESOURCE_EXHAUSTED unless this phrase is present.
  assert.ok(message.includes('no external evidence could be gathered'));
  assert.doesNotMatch(message, /quota|RESOURCE_EXHAUSTED/i);
}

// C2. Same graceful stop for single-provider modes, with accurate provider naming.
{
  assert.match(await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 }, 'google'), /^Search stopped: The Google fallback search returned no live results/);
  assert.match(await stopMessage({ google: 'empty', ddg: 'empty', gemini: 429 }, 'duckduckgo'), /^Search stopped: The DuckDuckGo fallback search returned no live results/);
}

// D. Not a quota problem -> the notice and reason say so instead of claiming quota exhaustion.
{
  const result = await run({ google: 'blocked', ddg: 'ok', gemini: 401 });
  assert.match(result.generationNote || '', /unavailable \(API key rejected\)/);
  assert.notEqual(result.fallbackReason, 'quota_exhausted');
}

// E. Gemini answered without error but produced no usable sources.
{
  const result = await run({ google: 'ok', ddg: 'ok', gemini: 200 });
  assert.match(result.generationNote || '', /unavailable \(no usable sources returned\)/);
  assert.equal(result.fallbackReason, 'no_content');
}

// F. Gemini-only mode keeps its existing user-facing error (no fallback involved).
{
  const message = await stopMessage({ google: 'ok', ddg: 'ok', gemini: 429 }, 'off');
  assert.match(message, /^Gemini is currently busy or rate-limited/);
}

// G. The server's placeholder payload is detectable, and real payloads never are.
{
  scenario = { google: 'empty', ddg: 'empty', gemini: 429 };
  const synthetic = await buildGoogleSearchFallbackPayload(QUERY, 'google_duckduckgo');
  assert.equal(isSyntheticFallbackPayload(synthetic), true);
  scenario = { google: 'ok', ddg: 'ok', gemini: 429 };
  assert.equal(isSyntheticFallbackPayload(await buildGoogleSearchFallbackPayload(QUERY, 'google_duckduckgo')), false);
  assert.equal(isSyntheticFallbackPayload(undefined), false);
}

// H. DuckDuckGo evidence delivered via the Lite or Instant Answer endpoints is recognised (HTML count may be 0).
{
  const base = { query: 'q', provider: 'duckduckgo', results: [{ title: 't', url: 'https://example.com', snippet: 's' }] } as SearchFallbackPayload;
  const liteOnly = { ...base, diagnostics: ['duckduckgo-html-q1:200', 'duckduckgo-results:0', 'duckduckgo-lite-q1:200', 'duckduckgo-lite-results:3'] };
  assert.equal(getFallbackResultCount(liteOnly, 'duckduckgo'), 3);
  assert.equal(describeFallbackEvidence(liteOnly, 'google_duckduckgo').source, 'duckduckgo');
  const instantOnly = { ...base, diagnostics: ['duckduckgo-results:0', 'duckduckgo-instant-results:2'] };
  assert.equal(getFallbackResultCount(instantOnly, 'duckduckgo'), 2);
  // Payloads without per-provider diagnostics (e.g. the Cypress fixtures) fall back to the declared provider.
  const fixtureShape = { ...base, provider: 'google', diagnostics: ['provider:google', 'result-count:8'] } as SearchFallbackPayload;
  assert.equal(describeFallbackEvidence(fixtureShape, 'google_duckduckgo').label, 'Google fallback (DuckDuckGo contributed no results)');
  assert.equal(describeFallbackEvidence({ ...base, diagnostics: undefined }, 'duckduckgo').label, 'DuckDuckGo fallback');
}

console.log('fallbackNotice regression tests passed');
