import assert from 'node:assert/strict';
import { extractRequestedFallbackMode, parseRequestPayload } from '../../server/googleSearchFallback.ts';
import { buildFallbackOverviewTitle, buildFallbackSearchUrl } from '../../src/services/searchFallbackShared.ts';
import { isSearchFallbackReason } from '../../src/types.ts';

const legacyPopulation = [
  {
    title: 'Example source',
    content: 'A short but valid content body for the regression test.',
    url: 'https://example.com/source',
  },
];

assert.deepEqual(parseRequestPayload(JSON.stringify(legacyPopulation)), {
  population: legacyPopulation,
});

const objectPayload = {
  population: [
    {
      title: 'Existing payload shape',
      content: 'This should continue to pass through unchanged.',
      url: 'https://example.com/object-shape',
    },
  ],
  generations: 4,
};

assert.deepEqual(parseRequestPayload(JSON.stringify(objectPayload)), objectPayload);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?provider=duckduckgo'), {}),
  'duckduckgo'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?mode=off'), {}),
  'off'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback'), { provider: 'duckduckgo' }),
  'duckduckgo'
);

assert.equal(
  extractRequestedFallbackMode(new URL('http://localhost/api/search-fallback?provider=invalid'), {}),
  'google_duckduckgo'
);

const duckDuckGoOnlyPayload = {
  query: 'Quantum Physics',
  mode: 'duckduckgo' as const,
  source: 'alternate-search-snippets' as const,
  provider: 'duckduckgo' as const,
  summary: 'DuckDuckGo summary',
  aiOverview: [],
  results: [
    {
      title: 'DuckDuckGo result',
      url: 'https://example.com/duckduckgo-result',
      domain: 'example.com',
      snippet: 'A fallback result from DuckDuckGo.',
    },
  ],
  extractedAt: 1,
  diagnostics: ['duckduckgo-results:1'],
};

assert.equal(
  buildFallbackOverviewTitle(duckDuckGoOnlyPayload),
  'Quantum Physics - DuckDuckGo Search Summary'
);

const duckDuckGoUrl = new URL(buildFallbackSearchUrl('Quantum Physics', 'duckduckgo'));
assert.equal(duckDuckGoUrl.hostname, 'duckduckgo.com');
assert.equal(duckDuckGoUrl.searchParams.get('q'), 'Quantum Physics');
assert.equal(duckDuckGoUrl.searchParams.get('ia'), 'web');

assert.equal(isSearchFallbackReason('network_unreachable'), true);
assert.equal(isSearchFallbackReason('not-a-reason'), false);

console.log('googleSearchFallback request payload regression checks passed');
