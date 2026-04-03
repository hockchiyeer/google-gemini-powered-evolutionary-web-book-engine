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
}

export interface EvolutionState {
  generation: number;
  population: WebPageGenotype[];
  bestFitness: number;
  status: 'idle' | 'searching' | 'parsing' | 'evolving' | 'assembling' | 'complete';
  artifacts?: {
    rawSearchResults?: any[];
    evolvedPopulation?: WebPageGenotype[];
    assemblyInput?: any;
    assemblyOutput?: any;
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
