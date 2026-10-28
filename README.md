# Evolutionary Web-Book Engine

An advanced AI-powered engine that synthesizes comprehensive, authoritative, multi-chapter digital "Web-Books" on any topic by mitigating search redundancy through evolutionary computation.

---

## Key Features

- **Two-Stage Evolutionary Content Synthesis**:
  - **Stage 1 (Architectural Roadmap)**: Synthesizes a structured 10-chapter outline flowing logically from historical foundations to core architecture, deep technical mechanics, and future horizons.
  - **Stage 2 (Parallel Chapter Expansion)**: Concurrently expands each chapter with rigorous technical definitions, sub-topic deep dives, and generative visual seeds.
- **Configurable AI Models**:
  - Dynamic model selection supporting modern Gemini models (`gemini-3.8-flash`, `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-flash-latest`).
  - Runtime model capability discovery. The selected model is always the one used; it is never silently swapped, and an unavailable model is reported in the notice (or as an error in `Off (Gemini only)` mode).
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
  - **Print Friendly PDF**: Reader-mode layout in the spirit of Edge Immersive Reader / LinkedIn reader view: one centred column, 12pt left-aligned sans-serif text with generous line spacing, clear headings, plain-list concepts/dimensions and clickable sources. The report opens in the browser print dialog (choose **Save as PDF**), so the PDF contains real vector text that is sharp at any zoom or printer resolution, selectable, searchable and screen-reader friendly. If printing is blocked, a 3x-resolution raster PDF is downloaded instead.
  - **Print Friendly Image (JPG)**: The same reader-mode layout rendered as one A4 JPG per page at 3x (about 288 dpi), packed from measured block heights so headings are never stranded at the bottom of a page. Multi-page reports download as `..._page_01_of_06.jpg` style files.
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
│   │   ├── printFriendlyReportExport.ts # Reader-mode print-friendly report generator (vector PDF via print, per-page JPG)
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
    ├── .cypress-cucumber-preprocessorrc.json # Cucumber BDD preprocessor configuration
    ├── cypress.config.cjs               # Cypress test configuration
    ├── cypress/
    │   ├── fixtures/                    # Test fixtures for deterministic search mock data
    │   ├── support/                     # Cypress commands and export stubs
    │   └── e2e/
    │       ├── features/
    │       │   └── webbook-generation.feature # BDD feature specifications
    │       ├── common/                  # Cucumber step definitions (Given, When, Then)
    │       └── pageObjects/             # Page object locators
    ├── scripts/                         # Server lifecycle and HTML report generator scripts
    └── server/                          # Server-side unit and regression tests
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

If inter-dependency conflicts occur during package installation:
```bash
# Workaround to enable installation given potential inter-dependencies conflicts
npm install --legacy-peer-deps
```

To inspect and resolve package security vulnerabilities:
```bash
# Check vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix --force
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

### 5. Production Build & Deployment

```bash
# Type check and build production assets
npm run build

# Start full-stack production server (serves frontend & API fallback routes)
npm start

# (Optional) Preview production client build locally
npm run preview
```

### 6. Automated Testing

The project includes an end-to-end Cypress BDD test suite with automated server lifecycle handling and visual HTML reporting.

#### Seamless Execution for Non-Technical Users (No Manual Server Setup)

You do **not** need to manually launch the local application server, configure ports, or provide a Gemini API key. Simply run:

```bash
npm test
# (or: npm run test)
```

**How the automated flow works:**
1. **Local Server Detection & Auto-Launch**: The runner checks whether `http://localhost:3000` is active. If not running, it automatically boots the local App server in the background and waits until it is ready.
2. **Deterministic & Safe Execution**: All 24 BDD test scenarios execute headlessly against mocked fixtures. **No Gemini API key or paid quota is required**, ensuring fast, reliable execution with zero risk to content integrity.
3. **Automated Server Teardown**: Automatically terminates the background server process once testing completes.
4. **HTML Report Generation**: Automatically compiles the visual, interactive HTML test report.

#### Viewing the Visual Test Report

After the test run completes, open the interactive HTML report in any web browser to view pass/fail metrics, step durations, and feature details:

- **Report Path**: `test-results/chromeReport/multiple-cucumber-html-report/index.html`

Convenient one-line commands to open the report directly:
- **macOS**: `open test-results/chromeReport/multiple-cucumber-html-report/index.html`
- **Windows**: `start test-results/chromeReport/multiple-cucumber-html-report/index.html`
- **Linux**: `xdg-open test-results/chromeReport/multiple-cucumber-html-report/index.html`

#### Test CLI Commands & Server Launch Matrix

The table below clarifies whether each `npm` / `npm run` command manages the local App server automatically or expects a pre-running server:

| Command | Local Server Launch | Purpose / Description |
| :--- | :--- | :--- |
| `npm test`<br>*(or `npm run test`)* | **Automatic** *(Self-managed; no manual start required)* | **Recommended primary command**. Automatically boots local server if not active, runs all 24 BDD scenarios headlessly, stops server, and compiles HTML report. |
| `npm run test:e2e`<br>*(or `npm run cy:run:local`)* | **Requires Running Server**<br>*(Run `npm run dev` first)* | Runs the full BDD test suite headlessly and compiles the HTML report against an already running local server. |
| `npm run cy:run` | **Requires Running Server**<br>*(Run `npm run dev` first)* | Runs Cypress headlessly against an already running server without re-generating HTML report. |
| `npm run cy:open` | **Requires Running Server**<br>*(Run `npm run dev` first)* | Opens the interactive Cypress GUI for visual step-by-step browser testing. |
| `npm run test:server` | **Not Required** *(Standalone)* | Runs server-side unit and regression tests (title extraction, search fallback routing, and evolution algorithms). |
| `npm run report:generate` | **Not Required** *(Standalone)* | Compiles the visual HTML report from existing Cucumber JSON test result artifacts. |

### 7. Code Verification

```bash
# Type check without emitting files
npm run lint
```

### 8. Google AI Studio Upload Packaging

```bash
# Package application source archive for Google AI Studio / external deployment
npm run package:aistudio
```

Generates a deployable source ZIP archive at `artifacts/evolutionary-web-book-engine-google-ai-studio-upload.zip`.

---

## How It Works

1. **Targeted Ingestion**: Gathers initial candidate sources via Gemini with Google Search grounding, preserving verified search URLs and domain citations. If quotas or rate limits are reached, the query transparently routes through the selected fallback provider (`Google + DuckDuckGo`, `Google`, or `DuckDuckGo`), and the notice reports the selected Gemini model, why it was unavailable, and which fallback providers actually supplied evidence. If the fallback providers also return nothing, generation stops with a message (instead of building a book from placeholder content) and the query stays in the search box so you can retry it as-is or refine the wording.
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

