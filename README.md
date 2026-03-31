# Evolutionary Web-Book Architect

An advanced AI-powered application that synthesizes comprehensive, authoritative "Web-Books" on any topic using an evolutionary content engine.

👉 You can explore the live application built from this repository’s source code at: https://aistudio.google.com/apps/84d53490-d503-494c-bf74-c67f1af980a8?showPreview=true&showAssistant=true

## 🚀 Features

- **Evolutionary Content Synthesis**: Uses a genetic algorithm-inspired approach to select, recombine, and mutate information from multiple AI-searched sources to create the most informative and authoritative content.
- **Automated Book Architecture**: Generates a logical 10-chapter outline for any topic, flowing from introduction to advanced concepts and future outlook.
- **Rich Content Generation**: Each chapter includes:
  - Deep, authoritative long-form text.
  - Key definitions extracted from source data.
  - Sub-topic "deep dives" for granular exploration.
  - AI-suggested visual seeds for imagery.
- **Multi-Format Export**: Export your generated books to:
  - **PDF**: High-quality paginated documents.
  - **HTML**: Self-contained web pages with "Back to Top" navigation and responsive design.
  - **Word (.docx)**: Editable documents with preserved structure.
  - **Text (.txt)**: Clean, readable plain text.
- **Resilient AI Integration**: Built-in retry mechanisms with exponential backoff to handle AI rate limits (429 errors) gracefully.
- **Search History**: Keep track of your generated books and revisit them anytime.

## 🛠️ Tech Stack

- **Frontend**: React 18+, TypeScript, Vite
- **Styling**: Tailwind CSS
- **AI Engine**: Google Gemini (via `@google/genai`)
- **Animations**: Framer Motion
- **Icons**: Lucide React
- **Export Libraries**: 
  - `jspdf` & `html2canvas` (PDF)
  - `docx` (Word)
  - `file-saver` (File handling)

## ⚙️ Setup & Installation

1. **Clone the repository** (or download the source).
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Environment Variables**:
   Create a `.env` file (or set in your environment):
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here
   ```
4. **Run the development server**:
   ```bash
   npm run dev
   ```
   The app will be available at `http://localhost:3000`.

## 📖 How It Works

1. **Search**: Enter a topic you want to explore.
2. **Extraction**: The AI searches for multiple high-quality sources and extracts raw "genotypes" (definitions, sub-topics, content summaries).
3. **Evolution**:
   - **Selection**: Sources are scored based on informative value and authority.
   - **Crossover**: The best information from different sources is combined to create "hybrid" insights.
   - **Fitness**: Content is ranked to ensure the highest quality synthesis.
4. **Assembly**: The AI architect builds a 10-chapter book structure and synthesizes the final "phenotype" (the readable book).

## 🛡️ Error Handling

The application is designed to be robust:
- **Rate Limiting**: Automatically retries AI calls if quota limits are hit.
- **JSON Repair**: Includes a custom JSON repair engine to handle truncated or malformed AI responses.
- **Defensive UI**: Gracefully handles missing data points without crashing the interface.

## 📄 License

MIT
