# Evolutionary Web-Book Engine

Evolutionary Web-Book Engine is a client-side React app that uses Google Gemini to search, extract, score, and synthesize Web knowledge into a styled multi-chapter "Web-book" for a user-supplied topic.

👉 You can explore the live application built from this repository’s source code at: [https://aistudio.google.com/apps/84d53490-d503-494c-bf74-c67f1af980a8?showPreview=true&showAssistant=true](https://aistudio.google.com/apps/84d53490-d503-494c-bf74-c67f1af980a8?showPreview=true&showAssistant=true)

The current repository is set up for local Vite development and also includes Google AI Studio app metadata (`metadata.json`) plus AI Studio-oriented environment variable notes in `.env.example`.

## What The Current App Does

- Accepts a topic query and runs a Gemini-powered search/extraction pass using the Google Search tool.
- Builds a candidate "population" of source summaries, definitions, and sub-topics.
- Scores and recombines those candidates across 3 evolutionary passes using informative value, authority, and redundancy penalty heuristics.
- Asks Gemini to produce a fixed 10-chapter outline, then generates chapter content, glossary items, and sub-topic analysis for each chapter.
- Filters out low-quality generated chapter content before the final book is assembled, so the rendered/exported book can contain fewer than 10 chapters.
- Renders a cover page, table of contents, chapter pages, glossary sections, and source references in the browser.
- Exposes a collapsible technical artifacts panel that shows captured search grounding, evolved population fitness, and assembly input/output trace data.
- Stores history in `localStorage`, and also syncs it to Firebase Auth + Cloud Firestore when Firebase environment variables are configured.
- Exports the current Web-book as high-resolution PDF, print-friendly PDF, Word-compatible `.doc`, standalone HTML, or plain text.

## Important Reality Checks

- This repo does not contain a custom web crawler or scraper. Search and extraction are delegated to Gemini through `@google/genai` and the `googleSearch` tool.
- The outline request is currently fixed at 10 chapters, but the final book can contain fewer chapters because generated chapter content is discarded when it fails the repo's quality checks.
- The "evolutionary" step is heuristic and lightweight: fitness scoring, top-half selection, and recombination are implemented; mutation is not meaningfully implemented in the current code.
- The redundancy term exists in the fitness function, but `evolve()` currently calls `calculateFitness()` with an empty comparison set, so redundancy is not actively affecting selection right now.
- Chapter images are loaded from `https://picsum.photos/...` using the chapter title or visual seed. They are decorative placeholders, not generated illustrations.
- The current app issues Gemini requests from the frontend bundle. For public deployment, you may want to introduce a backend proxy instead of exposing a browser-usable API key.
- High-resolution PDF export can fail for larger books in the browser because of memory/resource limits. The built-in "Print / Save as PDF" option is the more reliable fallback.
- Word export currently downloads `.doc`, not `.docx`.
- `package.json` still includes `express` and `dotenv`, but there is no checked-in backend/server implementation in the current repo.

## Tech Stack

- React 19
- TypeScript 5
- Vite 6
- Tailwind CSS 4 via `@tailwindcss/vite`
- Motion via `motion/react`
- Google Gemini via `@google/genai`
- Firebase Web SDK for optional persistence (Anonymous Auth + Cloud Firestore)
- `lucide-react` for UI icons
- `html2pdf.js` loaded from CDN in `index.html` for PDF export

## Current Repo Structure

```text
.
|-- .env.example
|-- index.html
|-- LICENSE.txt
|-- metadata.json
|-- package-lock.json
|-- package.json
|-- tsconfig.json
|-- vite.config.ts
`-- src
    |-- App.tsx
    |-- index.css
    |-- main.tsx
    |-- types.ts
    |-- services
    |   `-- evolutionService.ts
    `-- utils
        `-- webBookRender.ts
```

There is no checked-in backend server or API route in the current repo. The application logic lives entirely in `src/`.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from `.env.example`.

3. Provide at least:

```env
GEMINI_API_KEY="your_gemini_api_key"
```

4. Optionally enable persisted cloud history by setting the Firebase values from `.env.example` and enabling Anonymous Authentication plus Cloud Firestore in your Firebase project.

5. Start the app:

```bash
npm run dev
```

The dev server runs on `http://localhost:3000`.

## Available Scripts

- `npm run dev` - starts the Vite dev server on port 3000
- `npm run build` - creates a production build
- `npm run preview` - previews the production build
- `npm run lint` - runs TypeScript type checking via `tsc --noEmit`

Note: `npm run clean` exists in `package.json`, but it is currently `rm -rf dist`, so it assumes a Unix-like shell and is not portable to a plain Windows shell.

## How The Pipeline Currently Works

1. Gemini search/extraction: `src/services/evolutionService.ts` asks Gemini (`gemini-3-flash-preview`) to identify at least 5 relevant sources, return structured JSON, and capture grounding metadata.
2. Fitness scoring: each source is scored using informative score, authority score, and a redundancy penalty.
3. Selection/recombination: the top half of the population survives and paired survivors produce hybrid offspring across 3 generations.
4. Outline generation: Gemini produces a fixed 10-chapter outline for the requested topic.
5. Chapter generation: Gemini writes each chapter, definitions, and sub-topic analysis in parallel, and chapters with non-meaningful content are dropped from the final book.
6. Rendering and filtering: `src/utils/webBookRender.ts` removes low-quality or repetitive definitions/sub-topics and computes page layout for the on-screen/exported book.
7. Traceability: `src/App.tsx` stores raw search grounding, evolved population data, and assembly input/output in `EvolutionState.artifacts` for the in-app artifacts panel.

## Environment Variables

Required:

- `GEMINI_API_KEY`

Optional:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`

Present in `.env.example` but not used by the current source:

- `APP_URL`

Supported by `vite.config.ts` for AI Studio editing workflows:

- `DISABLE_HMR`

## License

MIT. See `LICENSE.txt`.
