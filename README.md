# Evolutionary Web-Book Engine

An advanced AI-powered engine that synthesizes comprehensive, authoritative, multi-chapter digital "Web-Books" on any topic by mitigating search redundancy through evolutionary computation.

---

## Key Features

- **Two-Stage Evolutionary Content Synthesis**:
  - **Stage 1 (Architectural Roadmap)**: Synthesizes a structured 10-chapter outline flowing logically from historical foundations to core architecture, deep technical mechanics, and future horizons.
  - **Stage 2 (Parallel Chapter Expansion)**: Concurrently expands each chapter with rigorous technical definitions, sub-topic deep dives, and generative visual seeds.
- **Configurable AI Models**:
  - Dynamic model selection supporting modern Gemini models (`gemini-3.8-flash`, `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-flash-latest`).
  - Runtime model capability discovery and automated candidate failover.
- **Multi-Tier Search Fallback Resilience**:
  - Graceful degradation when Gemini API quotas or rate limits are reached.
  - Configurable fallback routing: `Google + DuckDuckGo`, `Google only`, `DuckDuckGo only`, or `Off (Gemini only)`.
  - Offline evolutionary synthesis fallback ensuring books are generated even during upstream API outages.
- **Content Sanitization & Anti-Poisoning Heuristics**:
  - Heuristic screening for machine-code artifacts, hex bytes, and digit noise.
  - Automatic filtering of copyright disclaimers, scraper warnings, and promotional boilerplate.
- **Comprehensive Multi-Format Export**:
  - **PDF Document (High Res)**: Vector-grade document featuring a museum-grade cover, an interactive Table of Contents with clickable hyperlinks that jump directly to each chapter, and an editorial chapter layout (lead paragraph accent bars, key concept callout cards, deeper angle cards, and verified clickable source citations).
  - **Print / Save as PDF**: Responsive print-to-PDF formatting utilizing clean `@media print` rules, dedicated page breaks, and iframe + window print resilience.
  - **Word (.docx)**: Fully editable OpenXML document with preserved tables, glossaries, and embedded images.
  - **HTML Webpage**: Standalone responsive document with self-contained styling and navigational anchors.
  - **Plain Text (.txt)**: Clean, unformatted hierarchical text.
- **Dual-Layer Persistence & History**:
  - Cloud persistence via Firebase Firestore with anonymous authentication.
  - Local browser storage caching for offline review and instant retrieval.

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend Framework** | React 19, TypeScript, Vite 6 |
| **Styling & UI** | Tailwind CSS v4, Motion (`motion/react`), Lucide React |
| **AI Integration** | Google Gemini API via `@google/genai` |
| **Document Export** | `jspdf`, `html2pdf.js`, `fflate` (DOCX OpenXML packaging) |
| **Persistence** | Firebase Firestore, Firebase Auth, Web LocalStorage |
| **Server & Middleware** | Node.js, Express, Vite Server Plugin Middleware |
| **Testing** | Cypress with `@badeball/cypress-cucumber-preprocessor` (BDD Gherkin) |

---

## Repository Structure

```text
├── .env.example                         # Environment variable template
├── index.html                           # Application entry HTML
├── metadata.json                        # AI Studio applet capabilities and metadata
├── package.json                         # Project dependencies and npm scripts
├── tsconfig.json                        # TypeScript configuration
├── vite.config.ts                       # Vite configuration with Tailwind and search middleware
│
├── scripts/
│   ├── package-google-ai-studio.mjs     # Packaging utility for Google AI Studio deployments
│   ├── start-preview.mjs                # Production preview server runner
│   └── update_options.cjs               # Configuration synchronization script
│
├── server/
│   ├── googleSearchFallback.ts          # Express & Vite middleware for search fallback routes
│   ├── pdfBridge.ts                     # Server-side PDF generation bridge
│   ├── server.ts                        # Standalone full-stack server entry
│   └── searchStrategies/
│       ├── duckDuckGoStrategy.ts        # DuckDuckGo fallback scraper strategy
│       ├── googleStrategy.ts            # Google Search fallback strategy
│       ├── shared.ts                    # Search deduplication & ranking utilities
│       └── types.ts                     # Strategy typing definitions
│
├── src/
│   ├── App.tsx                          # Root application component
│   ├── WebBookViewer.tsx                # Interactive multi-page WebBook reader
│   ├── WebBookErrorBoundary.tsx         # Component-level error boundary
│   ├── index.css                        # Global Tailwind styles and print media rules
│   ├── main.tsx                         # Client application bootstrap
│   ├── types.ts                         # Core domain and genotype types
│   │
│   ├── components/
│   │   ├── AppHeader.tsx                # Header with navigation, model status, and export dropdown
│   │   ├── ControlSidebar.tsx           # Ingestion controls, model selector, and metrics panel
│   │   └── HistoryDrawer.tsx            # Slide-out archived Web-book drawer
│   │
│   ├── hooks/
│   │   └── useWebBookEngine.ts          # Core engine hook orchestrating search, evolution, and history
│   │
│   ├── services/
│   │   ├── documentTitle.ts             # Dynamic document title formatter
│   │   ├── docxExport.ts                # Word OpenXML (.docx) document builder
│   │   ├── evolutionService.ts          # Genetic algorithm, fitness evaluation, and Gemini assembly
│   │   ├── exportDocument.ts            # Document prep, inlining, and HTML print shells
│   │   ├── exportService.ts             # Multi-format export coordinator (PDF, Print, Word, HTML, TXT)
│   │   ├── fallbackPayloadHeuristics.ts # Heuristic quality scorers for search results
│   │   ├── geminiUserFacingErrors.ts    # Friendly error translation for API responses
│   │   ├── googleSearchFallbackClient.ts# Client interface to fallback search middleware
│   │   ├── historyService.ts            # Firestore and LocalStorage persistence layer
│   │   ├── searchFallbackShared.ts      # Shared scoring and URL builders
│   │   └── searchIntakeParser.ts        # Robust JSON and text stream parser
│   │
│   └── utils/
│       └── webBookRender.ts             # Pagination planner and source link sanitizers
│
└── tests/
    ├── cypress.config.cjs               # Cypress test configuration
    └── cypress/
        ├── fixtures/                    # Test fixtures for deterministic search mock data
        ├── support/                     # Cypress commands and export stubs
        └── e2e/
            ├── features/
            │   └── webbook-generation.feature # BDD feature specifications
            ├── common/                  # Cucumber step definitions (Given, When, Then)
            └── pageObjects/             # Page object locators
```

---

## Setup & Running

### 1. Prerequisites

- **Node.js**: v20 or higher
- **npm**: v10 or higher

### 2. Installation

```bash
npm install
```

### 3. Environment Setup

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

### 4. Development Server

Start the local development server:

```bash
npm run dev
```

The application will be accessible at `http://localhost:3000`.

### 5. Production Build & Preview

```bash
# Type check and build production assets
npm run build

# Preview production build locally
npm run preview
```

### 6. Code Verification

```bash
# Type check without emitting files
npm run lint
```

### 7. Google AI Studio Upload Packaging

```bash
# Package application source archive for Google AI Studio / external deployment
npm run package:aistudio
```

Generates a deployable source ZIP archive at `artifacts/evolutionary-web-book-engine-google-ai-studio-upload.zip`.

---

## How It Works

1. **Targeted Ingestion**: Gathers initial candidate sources via Gemini with Google Search grounding, preserving verified search URLs and domain citations. If quotas or rate limits are reached, the query transparently routes through the selected fallback provider (`Google + DuckDuckGo`, `Google`, or `DuckDuckGo`).
2. **Evolutionary Optimization**:
   - **Fitness Function**: Evaluates candidate text based on Informative Value $I(w)$, Source Authority $A(w)$, and a Redundancy Penalty $R(w, S)$.
   - **Selection & Crossover**: Selects top-scoring genotypes across successive generations to eliminate redundant boilerplate while preserving novel technical facts.
3. **Two-Stage Phenotype Assembly**:
   - Generates a holistic 10-chapter roadmap outline.
   - Concurrently expands chapters with detailed narrative prose, domain definitions, deeper exploratory angles, and visual concept seeds.
4. **Interactive Presentation & Export**:
   - Delivers an interactive multi-page WebBook with jump navigation, concept glossary, and source citations.
   - Enables one-click exports across PDF (with interactive TOC hyperlinks), Word, HTML, and text.

---

## License

Apache-2.0

