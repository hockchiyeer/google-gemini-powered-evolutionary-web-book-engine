# Evolutionary Web-Book Engine

Evolutionary Web-Book Engine is a React + Vite application that uses Google Gemini first, with a server-assisted Google Search / DuckDuckGo fallback, to search, extract, score, and synthesize Web knowledge into a styled multi-chapter Web-book for a user-supplied topic.

👉 You can explore the live application built from this repository’s source code at: [https://ai.studio/apps/31adbd5d-351d-4f99-8974-e1d1bb92f1f0](https://ai.studio/apps/31adbd5d-351d-4f99-8974-e1d1bb92f1f0)

This repository includes:

- a modular React frontend under `src/`
- a Vite middleware fallback route under `server/`
- Gemini-first generation with automatic search fallback and resilient model selection
- grounded synthetic evidence fallback when API quotas or web scrapers are blocked
- source-pool consolidation that can preserve 40-50 distinct evidence items before assembly
- deduplication for fallback-derived summaries, chapters, and source evidence
- unified export pipeline for high-res PDF, print / save-as-PDF, native Word `.docx`, HTML, and plain text

## What The App Does

- Accepts a topic query and generates a structured Web-book around that topic.
- Automatically defaults to the latest, most capable Google Gemini model available for free-tier users with dynamic model discovery and fallback across `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`, and user-defined custom model strings.
- Uses Google Gemini first for search extraction and chapter assembly.
- Consolidates a broader evidence pool before chapter writing so the generator is not forced to build a 10-chapter book from only a handful of sources.
- Falls back seamlessly when Gemini is unavailable, misconfigured, rate-limited, or daily quota is exceeded.
- Expands live search coverage with Google Search AI Overview, Google snippets, DuckDuckGo HTML snippets, and DuckDuckGo Lite results across multiple query variants.
- Employs a grounded synthetic fallback generator (`buildSyntheticFallbackPayload`) when live search scrapers are blocked or yield 0 snippets, ensuring a complete 10-chapter WebBook is always synthesized with real query links (Google, DuckDuckGo, Wikipedia, GitHub) without error popups.
- Deduplicates repeated fallback snippets, repeated chapter text, and repeated cross-chapter content.
- Builds an 18-source assembly pool and prunes that into a final 10-chapter Web-book.
- Renders a cover page, table of contents, chapter spreads, glossary sections, source links, and detailed reading links.
- Preserves search history in `localStorage`.
- Optionally syncs completed books to Firebase using Anonymous Auth + Cloud Firestore with graceful key error handling.
- Exposes a technical artifacts panel for raw search results, evolved population, and assembly trace data.

## Current Architecture

### Frontend

- `src/App.tsx` is a thin page-level orchestrator.
- `src/hooks/useWebBookEngine.ts` manages the search/evolution/assembly flow, carries the expanded assembly input set, and publishes artifact data to the UI.
- `src/components/` contains the header, sidebar, and history drawer:
  - `src/components/AppHeader.tsx` renders top navigation, action triggers, and the export menu dropdown.
  - `src/components/ControlSidebar.tsx` exposes model controls, fallback selector, query input, and execution metrics.
  - `src/components/HistoryDrawer.tsx` manages archived Web-books.
- `src/WebBookViewer.tsx` renders the main Web-book viewer.
- `src/services/` contains the evolution pipeline, fallback client, history persistence, shared search utilities, and export logic:
  - `src/services/evolutionService.ts` handles Gemini search grounding, model resilience, population evolution, and synthetic fallback generation.
  - `src/services/exportService.ts` provides unified handlers for high-res PDF export, system printing, Word document generation, HTML, and text export.
  - `src/services/exportDocument.ts` provides shared HTML document shell builders and DOM cloning utilities for all export targets.
  - `src/services/historyService.ts` manages local and Firebase Firestore search history with non-blocking auth error handling.
- `src/utils/webBookRender.ts` handles content filtering, render planning, and source-link normalization.

### Fallback Route

- `server/googleSearchFallback.ts` orchestrates the Vite middleware route at `/api/search-fallback`.
- The extraction logic is organized under `server/searchStrategies/` (`googleStrategy.ts`, `duckDuckGoStrategy.ts`, `shared.ts`, `types.ts`).
- Expands search coverage using query variants and interleave blending into a capped source pool.
- Returns grounded synthetic search evidence if automated web scraping encounters HTTP 429 blocks or empty result sets, preventing pipeline disruption.

## Search And Assembly Pipeline

1. **Search & Extract**: Perform Gemini search extraction in `src/services/evolutionService.ts`.
2. **Enrich Evidence**: Enrich Gemini extraction with live search evidence when available to consolidate 40-50 distinct source items.
3. **Fallback Recovery**: If Gemini encounters rate limits (429), quota exhaustion, network issues, or invalid keys, request `/api/search-fallback`.
4. **Live & Synthetic Extraction**:
   - Google Search AI Overview extraction
   - Google Search snippet extraction
   - DuckDuckGo HTML and DuckDuckGo Lite snippet extraction
   - Grounded synthetic topic evidence payload when scraping is blocked or yields sparse evidence
5. **Candidate Population**: Build a deduplicated population of candidate source pages.
6. **Evolutionary Scoring**: Score and recombine that population across 3 evolutionary passes, computing γ × R(w,S) redundancy penalties across generations.
7. **Assembly**: Assemble the final Web-book from an 18-source pool into 10 structured chapters.
8. **Render & Export**: Render the book with source verification links and export to the desired format.

## Repo Structure

```text
.
|-- .env.example
|-- .gitignore
|-- .npmrc
|-- GOOGLE_AI_STUDIO_UPLOAD.md
|-- LICENSE.txt
|-- README.md
|-- index.html
|-- metadata.json
|-- package-lock.json
|-- package.json
|-- tsconfig.json
|-- vite.config.ts
|-- scripts/
|   |-- package-google-ai-studio.mjs
|   `-- start-preview.mjs
|-- server/
|   |-- googleSearchFallback.ts
|   |-- pdfBridge.ts
|   |-- server.ts
|   `-- searchStrategies/
|       |-- duckDuckGoStrategy.ts
|       |-- googleStrategy.ts
|       |-- shared.ts
|       `-- types.ts
|-- tests/
|   |-- .cypress-cucumber-preprocessorrc.json
|   |-- cypress.config.cjs
|   |-- cypress.env.config.cjs
|   |-- cypress/
|   |   |-- e2e/
|   |   |   |-- common/
|   |   |   |-- features/
|   |   |   `-- pageObjects/
|   |   |-- fixtures/
|   |   `-- support/
|   |-- scripts/
|   `-- server/
`-- src/
    |-- App.tsx
    |-- WebBookErrorBoundary.tsx
    |-- WebBookViewer.tsx
    |-- index.css
    |-- main.tsx
    |-- types.ts
    |-- components/
    |   |-- AppHeader.tsx
    |   |-- ControlSidebar.tsx
    |   `-- HistoryDrawer.tsx
    |-- hooks/
    |   `-- useWebBookEngine.ts
    |-- services/
    |   |-- documentTitle.ts
    |   |-- docxExport.ts
    |   |-- evolutionService.ts
    |   |-- exportDocument.ts
    |   |-- exportService.ts
    |   |-- fallbackPayloadHeuristics.ts
    |   |-- geminiUserFacingErrors.ts
    |   |-- googleSearchFallbackClient.ts
    |   |-- historyService.ts
    |   |-- searchFallbackShared.ts
    |   `-- searchIntakeParser.ts
    `-- utils/
        `-- webBookRender.ts
```

## Local Development

### Requirements

- Node.js 18+ recommended
- npm

### Install

```bash
npm install
```

### Environment

Create `.env` from `.env.example`.

Recommended:

```env
GEMINI_API_KEY="your_gemini_api_key"
VITE_GEMINI_API_KEY="your_gemini_api_key"
```

Optional Firebase configuration:

```env
VITE_FIREBASE_API_KEY="..."
VITE_FIREBASE_AUTH_DOMAIN="..."
VITE_FIREBASE_PROJECT_ID="..."
VITE_FIREBASE_STORAGE_BUCKET="..."
VITE_FIREBASE_MESSAGING_SENDER_ID="..."
VITE_FIREBASE_APP_ID="..."
VITE_FIREBASE_MEASUREMENT_ID="..."
```

### Start The Dev Server

```bash
npm run dev
```

The app is configured to run on:

```text
http://localhost:3000
```

`vite.config.ts` uses `strictPort: true`, so the dev server will fail instead of silently moving to a different port.

Important:

- Use `npm run dev`
- Use `npm start` for hosted AI Studio / Cloud Run style runs so the app is built first and then served through `vite preview`

## Available Scripts

- `npm run dev` - start the Vite dev server on port 3000
- `npm run build` - create a production build
- `npm start` - build the app and serve it with `vite preview` on the platform `PORT`
- `npm run preview` - preview the built app
- `npm run lint` - run TypeScript type checking with `tsc --noEmit`
- `npm run clean` - remove `dist` using `rm -rf dist`
- `npm run test:local` - start test server on port 3000, run Cypress BDD suite, and generate HTML reports
- `npm run test:unit` - run server-side unit tests with `node --experimental-strip-types`
- `npm run test:prod` - run Cypress suite against production target
- `npm run report:generate` - generate Mochawesome and Cucumber HTML reports from Cypress artifacts

## Export Formats

The current Web-book can be exported as:

- **PDF Document (High Res)**: Renders a high-quality server-side PDF via Puppeteer (`/__pdf`) and downloads the `.pdf` file directly.
- **Print / Save as PDF**: Opens the browser's system print interface via a clean iframe so users can print physically or save via Chrome's native PDF printer without duplicate server requests.
- **Word (.docx)**: Exports a native `.docx` document package with embedded chapter images and hyperlinks.
- **HTML Webpage**: Downloads a standalone `.html` file preserving formatting and styling.
- **Plain Text (.txt)**: Generates a plain-text version of all chapters, definitions, and sources.

## History And Persistence

- Local history is always saved in `localStorage`.
- When Firebase environment variables are provided, completed books sync asynchronously to Cloud Firestore.
- Auth errors (such as invalid Firebase keys) fail gracefully without disrupting the user UI or search workflows.

## AI Studio Metadata

The repository includes `metadata.json` and `.env.example` configured for Google AI Studio app preview and packaging workflows.

## License

See [LICENSE.txt](LICENSE.txt).
