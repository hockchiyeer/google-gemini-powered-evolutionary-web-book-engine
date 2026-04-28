import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { getRenderableDefinitions, getRenderableSubTopics } from '../src/utils/webBookRender.ts';
import type {
  SearchFallbackMode,
  SearchFallbackPayload,
  WebPageGenotype,
  SearchFallbackResult,
} from '../src/types.ts';
import { isSearchFallbackMode } from '../src/types.ts';
import {
  buildFallbackOverviewTitle,
  buildFallbackSearchUrl as buildSearchUrl,
  deriveConceptLabel,
  mapFallbackArtifacts,
  scoreDomainAuthority,
  scoreInformativeText,
} from '../src/services/searchFallbackShared.ts';
import {
  MAX_RESULTS,
  buildDiagnostics,
  collapseWhitespace,
  dedupeSentences,
  interleaveSearchResults,
  normalizeComparableText,
  sanitizeFallbackSnippet,
  selectDistinctSearchResults,
} from './searchStrategies/shared.ts';
import { collectGoogleSearchEvidence } from './searchStrategies/googleStrategy.ts';
import { collectDuckDuckGoEvidence } from './searchStrategies/duckDuckGoStrategy.ts';

const SEARCH_ROUTE = '/api/search';
const EVOLVE_ROUTE = '/api/evolve';
const SEARCH_FALLBACK_ROUTE = '/api/search-fallback';
const MAX_SUMMARY_LENGTH = 2200;
const SEARCH_QUERY_VARIANTS = [
  '',
  'overview',
  'guide',
  'key concepts',
  'applications',
  'history',
];
const LEGACY_EVOLUTION_WEIGHTS = { alpha: 0.5, beta: 0.3, gamma: 0.2 };

type RequestPayload = Record<string, unknown>;

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

function buildSummary(query: string, aiOverview: ReadonlyArray<string>, results: ReadonlyArray<SearchFallbackResult>): string {
  if (aiOverview.length > 0) {
    return sanitizeFallbackSnippet(aiOverview.join(' ')).slice(0, MAX_SUMMARY_LENGTH);
  }

  const collected: string[] = [];

  for (const result of results) {
    for (const sentence of dedupeSentences(result.snippet, 4)) {
      if (collected.some((existing) => existing === sentence)) {
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

function normalizeFallbackMode(candidate: unknown): SearchFallbackMode | null {
  return isSearchFallbackMode(candidate) ? candidate : null;
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
    const { diagnostics: ddgDiagnostics } = ddgEvidence;
    const alternateResults = ddgEvidence.results;

    const blendedResults = selectDistinctSearchResults(
      interleaveSearchResults(googleResults, alternateResults),
      MAX_RESULTS
    );

    if (aiOverview.length > 0 || googleResults.length > 0) {
      const diagnostics = buildDiagnostics(googleAttempts as any, googleResults.length, 'google');
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
      const diagnostics = buildDiagnostics(googleAttempts as any, googleResults.length, 'google');
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

    const diagnostics = buildDiagnostics(googleAttempts as any, googleResults.length, 'google');
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
      diagnostics: buildDiagnostics(googleAttempts as any, googleResults.length, 'google'),
    };
  }

  if (googleEvidence?.didBlock) {
    throw new Error(
      `Google Search blocked automated extraction with 429 responses. ${buildDiagnostics(googleAttempts as any, googleResults.length, 'google').join(' | ')}`
    );
  }

  throw new Error(`No extractable search snippets were available. ${buildDiagnostics(googleAttempts as any, googleResults.length, 'google').join(' | ')}`);
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

export function createApiCompatibilityMiddleware() {
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
      console.error('API Middleware Error:', error);
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : 'Internal server error in search fallback middleware'
        });
      } else {
        next(error);
      }
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
