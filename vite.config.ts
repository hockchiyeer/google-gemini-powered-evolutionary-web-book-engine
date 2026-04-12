import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import { googleSearchFallbackPlugin } from './server/googleSearchFallback.ts';
import { generatePdf } from './server/pdfBridge.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolvePort(candidate: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(candidate || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAiStudioHostedApp(appUrl: string | undefined): boolean {
  const normalized = appUrl?.trim();
  if (!normalized) {
    return false;
  }

  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return (
      hostname.endsWith('.run.app') ||
      hostname.endsWith('.a.run.app') ||
      hostname.includes('aistudio') ||
      hostname.includes('googleusercontent')
    );
  } catch {
    const lower = normalized.toLowerCase();
    return lower.includes('run.app') || lower.includes('aistudio');
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const geminiApiKey = typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim().length > 0
    ? env.GEMINI_API_KEY
    : 'process.env.GEMINI_API_KEY';
  const previewPort = resolvePort(process.env.PORT || env.PORT, 3000);
  const disableHmr = process.env.DISABLE_HMR === 'true'
    || env.DISABLE_HMR === 'true'
    || isAiStudioHostedApp(env.APP_URL);

  return {
    plugins: [
      react(),
      tailwindcss(),
      googleSearchFallbackPlugin(),
      {
        name: 'pdf-bridge',
        configurePreviewServer(server) {
          server.middlewares.use('/__pdf', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end();
            }
            try {
              let body = '';
              req.on('data', (chunk) => {
                body += chunk;
              });
              req.on('end', async () => {
                const { html, fileName } = JSON.parse(body);
                const pdfBuffer = await generatePdf(html);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                  'Content-Disposition',
                  `attachment; filename="${fileName || 'webbook'}.pdf"`
                );
                res.end(pdfBuffer);
              });
            } catch (err) {
              console.error(err);
              res.statusCode = 500;
              res.end('PDF generation failed');
            }
          });
        },
        configureServer(server) {
          server.middlewares.use('/__pdf', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end();
            }
            try {
              let body = '';
              req.on('data', (chunk) => {
                body += chunk;
              });
              req.on('end', async () => {
                const { html, fileName } = JSON.parse(body);
                const pdfBuffer = await generatePdf(html);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                  'Content-Disposition',
                  `attachment; filename="${fileName || 'webbook'}.pdf"`
                );
                res.end(pdfBuffer);
              });
            } catch (err) {
              console.error(err);
              res.statusCode = 500;
              res.end('PDF generation failed');
            }
          });
        },
      },
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(geminiApiKey),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      strictPort: true,
      // Disable HMR in iframe-proxied hosted environments where the websocket
      // is unreachable and only adds noisy console errors.
      hmr: disableHmr ? false : undefined,
    },
    preview: {
      host: '0.0.0.0',
      port: previewPort,
      strictPort: true,
    },
  };
});
