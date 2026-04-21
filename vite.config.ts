import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import { googleSearchFallbackPlugin } from './server/googleSearchFallback.ts';
// pdfBridge is loaded lazily inside the middleware handler so that a missing
// puppeteer devDependency does not crash the vite preview/dev server on startup.

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

const AI_STUDIO_GEMINI_API_KEY_PLACEHOLDER = 'process.env.GEMINI_API_KEY';

function serverFileRestartPlugin() {
  let isRestarting = false;
  const watchedRoots = [
    path.resolve(__dirname, 'server'),
    path.resolve(__dirname, 'vite.config.ts'),
  ];

  const shouldRestartForFile = (file: string): boolean => {
    const normalizedFile = path.resolve(file);
    return watchedRoots.some((root) => (
      normalizedFile === root || normalizedFile.startsWith(`${root}${path.sep}`)
    ));
  };

  return {
    name: 'server-file-restart',
    apply: 'serve' as const,
    configureServer(server: any) {
      const restartIfNeeded = async (file: string) => {
        if (isRestarting || !shouldRestartForFile(file) || typeof server.restart !== 'function') {
          return;
        }

        isRestarting = true;
        try {
          console.log(`[server-file-restart] Restarting Vite dev server due to change in ${path.relative(__dirname, file)}`);
          await server.restart();
        } catch (error) {
          console.error('[server-file-restart] Failed to restart Vite dev server', error);
        } finally {
          isRestarting = false;
        }
      };

      server.watcher.on('add', restartIfNeeded);
      server.watcher.on('change', restartIfNeeded);
      server.watcher.on('unlink', restartIfNeeded);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  // AI Studio expects the literal placeholder string `process.env.GEMINI_API_KEY`
  // in client-side code so its proxy can attach the active user's key without
  // exposing a real secret in the bundle.
  const resolvedApiKey = env.GEMINI_API_KEY?.trim()
    || env.VITE_GEMINI_API_KEY?.trim()
    || AI_STUDIO_GEMINI_API_KEY_PLACEHOLDER;
  const previewPort = resolvePort(process.env.PORT || env.PORT, 3000);
  const disableHmr = process.env.DISABLE_HMR === 'true'
    || env.DISABLE_HMR === 'true'
    || isAiStudioHostedApp(env.APP_URL);

  return {
    plugins: [
      serverFileRestartPlugin(),
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
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
              body += chunk;
            });
            req.on('error', (err) => { console.error('Request error:', err); res.statusCode = 400; res.end('Bad Request'); }); req.on('end', async () => {
              try {
                const { html, fileName } = JSON.parse(body);
                // Lazy import so puppeteer absence (devDep) does not crash startup.
                let generatePdf: ((h: string) => Promise<Buffer>) | null = null;
                try {
                  const bridge = await import('./server/pdfBridge.ts');
                  generatePdf = bridge.generatePdf;
                } catch {
                  /* puppeteer not installed — PDF generation unavailable */
                }
                if (!generatePdf) {
                  res.statusCode = 503;
                  return res.end('PDF generation unavailable: puppeteer is not installed.');
                }
                const pdfBuffer = await generatePdf(html);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                  'Content-Disposition',
                  `attachment; filename="${fileName || 'webbook'}.pdf"`
                );
                res.end(pdfBuffer);
              } catch (err) {
                console.error('PDF generation error (preview):', err);
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                res.statusCode = 500;
                res.end(`PDF generation failed: ${errorMessage}`);
              }
            });
          });
        },
        configureServer(server) {
          server.middlewares.use('/__pdf', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              return res.end();
            }
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
              body += chunk;
            });
            req.on('error', (err) => { console.error('Request error:', err); res.statusCode = 400; res.end('Bad Request'); }); req.on('end', async () => {
              try {
                const { html, fileName } = JSON.parse(body);
                // Lazy import so puppeteer absence (devDep) does not crash startup.
                let generatePdf: ((h: string) => Promise<Buffer>) | null = null;
                try {
                  const bridge = await import('./server/pdfBridge.ts');
                  generatePdf = bridge.generatePdf;
                } catch {
                  /* puppeteer not installed — PDF generation unavailable */
                }
                if (!generatePdf) {
                  res.statusCode = 503;
                  return res.end('PDF generation unavailable: puppeteer is not installed.');
                }
                const pdfBuffer = await generatePdf(html);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                  'Content-Disposition',
                  `attachment; filename="${fileName || 'webbook'}.pdf"`
                );
                res.end(pdfBuffer);
              } catch (err) {
                console.error('PDF generation error (dev):', err);
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                res.statusCode = 500;
                res.end(`PDF generation failed: ${errorMessage}`);
              }
            });
          });
        },
      },
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(resolvedApiKey),
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
