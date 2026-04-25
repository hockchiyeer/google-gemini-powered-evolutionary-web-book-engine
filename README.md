# Evolutionary Web-Book Engine

Evolutionary Web-Book Engine is a React + Vite application that uses Google Gemini first, with a server-assisted Google Search / DuckDuckGo fallback, to search, extract, score, and synthesize Web knowledge into a styled multi-chapter Web-book for a user-supplied topic.

👉 You can explore the live application built from this repository’s source code at: [https://aistudio.google.com/apps/84d53490-d503-494c-bf74-c67f1af980a8?showPreview=true&showAssistant=true](https://aistudio.google.com/apps/84d53490-d503-494c-bf74-c67f1af980a8?showPreview=true&showAssistant=true)

This repository now includes:

- a modular React frontend under `src/`
- a Vite middleware fallback route under `server/`
- Gemini-first generation with automatic search fallback
- source-pool consolidation that can preserve roughly 40-50 distinct evidence items before assembly
- deduplication for fallback-derived summaries, chapters, and source evidence
- export to PDF, print, native Word `.docx`, HTML, and plain text

## What The App Does

- Accepts a topic query and generates a structured Web-book around that topic.
- Uses Google Gemini first for search extraction and chapter assembly.
- Consolidates a broader evidence pool before chapter writing so the generator is not forced to build a 10-chapter book from only a handful of sources.
- Falls back when Gemini is unavailable, misconfigured, rate-limited, or quota-limited.
- Builds fallback content from live search evidence instead of hardcoded placeholder text.
- Expands live search coverage with Google Search AI Overview, Google snippets, DuckDuckGo HTML snippets, and DuckDuckGo Lite results across multiple query variants.
- Deduplicates repeated fallback snippets, repeated chapter text, and repeated cross-chapter content.
- Builds an 18-source assembly pool and prunes that into a final 10-chapter Web-book.
- Renders a cover page, table of contents, chapter spreads, glossary sections, source links, and detailed reading links.
- Preserves search history in `localStorage`.
- Optionally syncs completed books to Firebase using Anonymous Auth + Cloud Firestore.
- Exposes a technical artifacts panel for raw search results, evolved population, and assembly trace data.

## Current Architecture

### Frontend

- `src/App.tsx` is now a thin page-level orchestrator.
- `src/hooks/useWebBookEngine.ts` manages the search/evolution/assembly flow, carries the expanded assembly input set, and publishes artifact data to the UI.
- `src/components/` contains the header, sidebar, and history drawer.
- `src/WebBookViewer.tsx` renders the main Web-book viewer.
- `src/components/ControlSidebar.tsx` shows population size, search coverage summary, evolved population, and assembly trace metrics.
- `src/services/` contains the evolution pipeline, fallback client, history persistence, shared search utilities, and export logic.
- `src/services/fallbackPayloadHeuristics.ts` centralizes checks for whether fallback search payloads contain enough usable evidence to continue assembly.
- `src/services/searchFallbackShared.ts` provides centralized text-similarity scoring and stopword utilities shared by the evolution pipeline and the server-side fallback route.
- `src/utils/webBookRender.ts` handles content filtering, render planning, and source-link normalization.

### Fallback Route

- `server/googleSearchFallback.ts` adds a Vite middleware route at `/api/search-fallback`.
- The fallback route now expands coverage with multiple query variants and blends distinct Google and DuckDuckGo results into a larger capped source pool.
- The fallback route is used when Gemini fails due to:
  - missing API key
  - invalid API key
  - quota or rate limit
  - service unavailability
- Fallback output is synthesized from live search results and is deduplicated before it reaches the UI.

## Search And Assembly Pipeline

1. Search and extract with Gemini in `src/services/evolutionService.ts`.
2. Enrich Gemini extraction with live search evidence when available so the consolidated source pool can approach roughly 40-50 distinct items.
3. If Gemini fails for a known recoverable reason, request `/api/search-fallback`.
4. The fallback route attempts:
   - Google Search AI Overview extraction
   - Google Search snippet extraction
   - DuckDuckGo HTML and DuckDuckGo Lite snippet extraction as alternate providers
   - multiple search-query variants to widen coverage when one phrasing returns sparse results
5. Build a deduplicated candidate population of source pages.
6. Score and recombine that population across 3 lightweight evolutionary passes. Each page is scored against every other page in its generation so the γ × R(w,S) redundancy penalty is genuinely computed.
7. Assemble the final Web-book from an 18-source assembly pool into 10 chapters.
8. Render the book with source verification links and external article links.
9. Export the result if needed.

## Repo Structure

Key checked-in structure is shown below. Generated local directories such as `artifacts/`, `dist/`, `node_modules/`, and `test-results/` are omitted for clarity.

```text
.
|-- .env.example
|-- .gitignore
|-- .npmrc
|-- GOOGLE_AI_STUDIO_UPLOAD.md
|-- index.html
|-- LICENSE.txt
|-- metadata.json
|-- package-lock.json
|-- package.json
|-- README.md
|-- tsconfig.json
|-- vite.config.ts
|-- scripts
|   |-- package-google-ai-studio.mjs
|   `-- start-preview.mjs
|-- server
|   |-- googleSearchFallback.ts
|   |-- pdfBridge.ts
|   `-- server.ts
|-- tests
|   |-- cypress.config.cjs
|   |-- cypress.env.config.cjs
|   |-- server
|   |-- scripts
|   `-- cypress
`-- src
    |-- App.tsx
    |-- index.css
    |-- main.tsx
    |-- types.ts
    |-- WebBookErrorBoundary.tsx
    |-- WebBookViewer.tsx
    |-- components
    |   |-- AppHeader.tsx
    |   |-- ControlSidebar.tsx
    |   `-- HistoryDrawer.tsx
    |-- hooks
    |   `-- useWebBookEngine.ts
    |-- services
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
    `-- utils
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

Notes:

- `VITE_GEMINI_API_KEY` is the simplest option for regular browser-hosted deployments.
- `GEMINI_API_KEY` works for local or server-backed runs that inject a real value at build time.
- Google AI Studio shared apps should keep the literal `process.env.GEMINI_API_KEY` placeholder available in the client bundle so AI Studio can proxy Gemini calls securely.
- Gemini is recommended, but the app can still fall back to search-based synthesis when Gemini is unavailable.
- `APP_URL` is present in `.env.example` for AI Studio style hosting metadata, but it is not required for normal local development.
- `DISABLE_HMR=true` can be used in environments where hot reload causes instability.

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
- Do not use `npx run dev`
- Use `npm start` for hosted AI Studio / Cloud Run style runs so the app is built first and then served through `vite preview`

`npx run dev` installs the unrelated `run` package and does not execute the Vite script from `package.json`.

## Available Scripts

- `npm run dev` - start the Vite dev server on port 3000
- `npm run build` - create a production build
- `npm start` - build the app and serve it with `vite preview` on the platform `PORT` (recommended for AI Studio / Cloud Run hosting)
- `npm run preview` - preview the built app
- `npm run lint` - run TypeScript type checking with `tsc --noEmit`
- `npm run clean` - remove `dist` using `rm -rf dist`
- `npm run test:local` - start the test dev server on port 3000, run the Cypress BDD suite, and generate both HTML reports
- `npm run test:unit` - run the server-side unit tests with `node --experimental-strip-types`
- `npm run test:prod` - run the Cypress suite against PROD and generate both HTML reports
- `npm run report:generate` - generate both the Mochawesome HTML report and the Multiple Cucumber HTML report from the latest Cypress artifacts

Note: `npm run clean` is not Windows-native because it uses `rm -rf`.

## Test Reports

Cypress report artifacts are written under `test-results/chromeReport/`.

After a Cypress run, or by running the generator directly:

```bash
npm run report:generate
```

This produces:

- Mochawesome HTML report at `test-results/chromeReport/report.html`
- Multiple Cucumber HTML report at `test-results/chromeReport/multiple-cucumber-html-report/index.html`

## Cypress Folder Structure

```text
tests/
|-- cypress.config.cjs
|-- cypress.env.config.cjs
|-- .cypress-cucumber-preprocessorrc.json
|-- scripts/
|   |-- generate-cucumber-report.cjs
|   |-- run-cypress-with-reports.cjs
|   |-- run-local-cypress.cjs
|   `-- smoke/                        ← manual smoke-test scripts
|       |-- test-import.js
|       |-- test-pdf.ts
|       |-- test-search.ts
|       `-- test.pdf
|-- server/                           ← server-side unit tests
|   |-- documentTitle.test.ts
|   |-- evolutionService.test.ts
|   `-- googleSearchFallback.test.ts
`-- cypress/
    |-- e2e/                          ← ACTIVE Cucumber tree
    |   |-- features/
    |   |   `-- webbook-generation.feature
    |   |-- common/
    |   |   |-- given.js
    |   |   |-- when.js
    |   |   `-- then.js
    |   `-- pageObjects/              ← imported by support/commands.js
    |       |-- index.js
    |       `-- webBookEngine.js
    |-- fixtures/
    |   |-- 1x1.png
    |   |-- example.json
    |   |-- search-fallback-quantum-physics.json
    |   `-- search-fallback-quantum-physics-live-shape.json
    `-- support/
        |-- e2e.js
        `-- commands.js
```

- `tests/cypress/e2e/features/` holds the active Gherkin feature files matched by `specPattern` in `cypress.config.cjs`.
- `tests/cypress/e2e/common/` holds the active Cucumber step definitions (given, when, then).
- `tests/cypress/e2e/pageObjects/` contains the selector maps imported by `tests/cypress/support/commands.js`.
- `tests/cypress/fixtures/` stores stubbed API payloads and test data used by `cy.fixture()`.
- `tests/cypress/support/` bootstraps Cypress and registers all reusable custom commands.
- `tests/server/` contains server-side unit tests run via `npm run test:unit`.
- `tests/scripts/smoke/` contains informal one-off debugging scripts for manual verification of server internals.

## Export Formats

The current Web-book can be exported as:

- high-resolution PDF
- print / save as PDF
- Word `.docx`
- standalone HTML
- plain text

Current export behavior:

- PDF export uses a zero-server Puppeteer pipeline (via Vite middleware) to generate high-quality server-side PDFs without crashing the browser thread.
- HTML export preserves the rendered Web-book layout and links.
- Word export produces a native `.docx` package with embedded chapter images and clickable internal and external links where supported.
- The legacy print flow remains available as a simple browser fallback.

## Search Fallback Behavior

When Gemini cannot be used, the app switches to search-based synthesis:

- Google Search AI Overview extraction when available
- Google Search snippets when AI Overview is not extractable
- DuckDuckGo HTML and DuckDuckGo Lite snippets when Google blocks automated extraction
- multiple query variants so sparse wording from one search can still contribute to a larger blended result set
- deduplicated blending of Google and DuckDuckGo evidence up to a much larger capped source pool before assembly

Fallback content is then deduplicated at multiple stages:

- result snippet deduplication in `server/googleSearchFallback.ts`
- fallback population deduplication in `src/services/evolutionService.ts`
- cross-chapter sentence deduplication during fallback book assembly
- synthesis-chapter filtering so it does not simply repeat standalone source chapters

### Source Routing Matrix

Expected source routing by scenario:

1. Gemini search succeeds and yields usable external evidence:
   - Keep `sourceMode: gemini`.
   - Optionally enrich with `/api/search-fallback` evidence when available.
   - Continue evolution and assembly.
2. Gemini search succeeds but yields too little usable external evidence:
   - Attempt `/api/search-fallback` immediately.
   - If fallback returns usable results, switch to `sourceMode: search-fallback` and continue with blended evidence.
   - If fallback is unavailable, fail the run with an error rather than generating a placeholder one-chapter book.
3. Gemini search fails for a recoverable reason (missing/invalid key, quota/rate limit, temporary service/network issues):
   - Attempt `/api/search-fallback`.
   - If fallback returns usable results, continue in `sourceMode: search-fallback`.
   - If fallback is unavailable, fail with a clear error instead of assembling from an empty local pool.
4. Gemini chapter assembly fails after a successful search/evolution stage:
   - Attempt `/api/search-fallback` to augment/recover.
   - If fallback is unavailable, the app may still assemble from current evolved evidence only when that evidence is substantive.
   - If evidence is too thin, fail with an explicit error instead of exporting synthetic placeholder prose.

## History And Persistence

- Local history is always stored in `localStorage`.
- If Firebase config is provided, the app also:
  - signs in anonymously
  - stores started / completed / failed searches
  - syncs completed books from Firestore

Firebase support is implemented in `src/services/historyService.ts`.

## Deployment Notes

This repo is not purely static anymore.

The endpoints live in Vite middleware:

```text
/api/search
/api/evolve
/api/search-fallback
/__pdf
```

Notes:

- `/api/search` and `/api/evolve` are legacy compatibility routes for older AI Studio-hosted clients that still expect the earlier server contract.
- `/api/search-fallback` remains the primary live search fallback route used by the current checked-in frontend.

That means:

- `npm run dev` supports the fallback route
- `npm run preview` supports the fallback route
- `npm start` builds first, then serves the preview server on `0.0.0.0:$PORT`, which is the best fit for AI Studio / Cloud Run style hosting
- a plain static hosting deployment of only the built `dist/` assets will not provide that route by itself

If you deploy beyond local Vite dev/preview, recreate the fallback route in a real backend or edge/serverless function.

### Google AI Studio Upload Package

This repository can generate a lean source archive for upload and handoff workflows:

```bash
npm run package:aistudio
```

That writes:

```text
artifacts/evolutionary-web-book-engine-google-ai-studio-upload.zip
```

The package keeps the runnable app files at the root of the zip and excludes local-only folders such as `.git/`, `node_modules/`, `dist/`, `test-results/`, and `tests/`.

### Google AI Studio Hosting Notes

When this app is hosted inside Google AI Studio, several console messages can appear even when the app itself is healthy:

- Monaco / CSP warnings such as `Could not create web worker(s)` come from the AI Studio editor shell, not from this repo.
- `Origin trial controlled feature not enabled` warnings also come from the host environment and are not part of the Web-book engine.
- Vite websocket errors such as `[vite] failed to connect to websocket` mean the app is being served in dev mode through an iframe proxy. The repo now auto-disables HMR when `APP_URL` looks like an AI Studio / Cloud Run deployment, and `npm start` avoids the dev websocket entirely.

Important runtime check:

- Current source from this repo uses direct Gemini browser calls plus `/api/search-fallback`.
- Some AI Studio-hosted clients may still call `/api/search` or `/api/evolve`. The server now includes compatibility middleware for those legacy routes so older hosted wrappers can still function.
- If the hosted app console shows `/api/search` or `/api/evolve` and the request still fails after redeploy, that usually means the host is still serving an older wrapper or an incomplete deployment.
- Google AI Studio Build mode currently documents export-out workflows, but not importing a local app zip back into AI Studio as an editable project.

## Known Limitations

- The evolutionary stage is still lightweight. It uses scoring, survivor selection, and recombination, but it is not a full genetic algorithm implementation.
- Decorative chapter images come from `picsum.photos`; they are placeholders, not topic-aware generated illustrations.
- `dotenv` is present in dependencies, but the checked-in backend endpoints are implemented as Vite middleware rather than a standalone Express server.
- A plain static hosting deployment of the built `dist/` assets will not include the `/api/search-fallback` or `/__pdf` routes — a real backend or edge/serverless function is required for those.

## AI Studio Metadata

The repo includes `metadata.json` and `.env.example` notes that are useful for Google AI Studio style app packaging, but the project is fully runnable as a normal local Vite app.

## License

See [LICENSE.txt](LICENSE.txt).
