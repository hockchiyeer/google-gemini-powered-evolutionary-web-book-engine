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

export type WebBookSourceMode = 'gemini' | 'search-fallback';
export type SearchFallbackSource = 'google-ai-overview' | 'google-search-snippets' | 'alternate-search-snippets';
export type SearchFallbackProvider = 'google' | 'duckduckgo';
export type SearchFallbackReason =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'quota_or_rate_limit'
  | 'service_unavailable';

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
}

export interface SearchFallbackPayload {
  query: string;
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
