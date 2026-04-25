export interface Definition {
  term: string;
  description: string;
  sourceUrl: string;
}

export interface SubTopic {
  title: string;
  summary: string;
  sourceUrl: string;
}

export interface WebPageGenotype {
  id: string;
  url: string;
  title: string;
  content: string;
  definitions: Definition[];
  subTopics: SubTopic[];
  informativeScore: number; // I(w)
  authorityScore: number;   // A(w)
  fitness: number;          // F(w)
}

export const WEB_BOOK_SOURCE_MODES = ['gemini', 'search-fallback'] as const;
export type WebBookSourceMode = typeof WEB_BOOK_SOURCE_MODES[number];

export const SEARCH_FALLBACK_SOURCES = [
  'google-ai-overview',
  'google-search-snippets',
  'alternate-search-snippets',
] as const;
export type SearchFallbackSource = typeof SEARCH_FALLBACK_SOURCES[number];

export const SEARCH_FALLBACK_PROVIDERS = ['google', 'duckduckgo'] as const;
export type SearchFallbackProvider = typeof SEARCH_FALLBACK_PROVIDERS[number];

export const SEARCH_FALLBACK_MODES = ['off', 'google', 'duckduckgo', 'google_duckduckgo'] as const;
export type SearchFallbackMode = typeof SEARCH_FALLBACK_MODES[number];
export interface SearchFallbackOptions {
  mode: SearchFallbackMode;
}

export const SEARCH_FALLBACK_REASONS = [
  'missing_api_key',
  'invalid_api_key',
  'quota_or_rate_limit',
  'service_unavailable',
  'network_unreachable',
] as const;
export type SearchFallbackReason = typeof SEARCH_FALLBACK_REASONS[number];

export function isWebBookSourceMode(value: unknown): value is WebBookSourceMode {
  return typeof value === 'string' && WEB_BOOK_SOURCE_MODES.includes(value as WebBookSourceMode);
}

export function isSearchFallbackSource(value: unknown): value is SearchFallbackSource {
  return typeof value === 'string' && SEARCH_FALLBACK_SOURCES.includes(value as SearchFallbackSource);
}

export function isSearchFallbackProvider(value: unknown): value is SearchFallbackProvider {
  return typeof value === 'string' && SEARCH_FALLBACK_PROVIDERS.includes(value as SearchFallbackProvider);
}

export function isSearchFallbackMode(value: unknown): value is SearchFallbackMode {
  return typeof value === 'string' && SEARCH_FALLBACK_MODES.includes(value as SearchFallbackMode);
}

export function isSearchFallbackReason(value: unknown): value is SearchFallbackReason {
  return typeof value === 'string' && SEARCH_FALLBACK_REASONS.includes(value as SearchFallbackReason);
}

export interface SearchArtifact {
  web?: {
    title?: string;
    uri?: string;
  };
  snippet?: string;
}

export interface SearchFallbackResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  excerpt?: string;
}

export interface SearchFallbackPayload {
  query: string;
  mode?: SearchFallbackMode;
  source: SearchFallbackSource;
  provider: SearchFallbackProvider;
  summary: string;
  aiOverview: string[];
  results: SearchFallbackResult[];
  extractedAt: number;
  diagnostics?: string[];
}

export interface Chapter {
  title: string;
  content: string;
  definitions: Definition[];
  subTopics: SubTopic[];
  sourceUrls: Array<string | { title: string; url: string }>;
  visualSeed: string; // Keyword for image generation
}

export interface WebBook {
  id: string;
  topic: string;
  timestamp: number;
  chapters: Chapter[];
  completedGenerations?: number;
  sourceMode?: WebBookSourceMode;
  generationNote?: string;
  fallbackSource?: SearchFallbackSource;
  fallbackReason?: SearchFallbackReason;
}

export interface EvolutionState {
  generation: number;
  population: WebPageGenotype[];
  bestFitness: number;
  bestInformativeScore?: number;
  bestAuthorityScore?: number;
  bestRedundancyPenalty?: number;
  status: 'idle' | 'searching' | 'parsing' | 'evolving' | 'assembling' | 'complete';
  artifacts?: {
    rawSearchResults?: SearchArtifact[];
    evolvedPopulation?: WebPageGenotype[];
    assemblyInput?: any;
    assemblyOutput?: any;
    searchSummary?: string;
  };
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_GEMINI_API_KEY?: string;
    readonly VITE_FIREBASE_API_KEY?: string;
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
    readonly VITE_FIREBASE_PROJECT_ID?: string;
    readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
    readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
    readonly VITE_FIREBASE_APP_ID?: string;
    readonly VITE_FIREBASE_MEASUREMENT_ID?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
