import puppeteer from 'puppeteer';

// ---------------------------------------------------------------------------
// generatePdf
//
// Bug fixed: the previous implementation used waitUntil: 'networkidle0' which
// instructed Puppeteer to wait until there were zero in-flight network requests
// for at least 500 ms.  The Tailwind CDN script loaded inside the exported HTML
// triggers cascading sub-requests (JIT CSS class scanning, analytics pings) that
// continuously keep that counter above zero.  After the 300 s timeout the browser
// context was forcibly closed by Puppeteer, causing page.pdf() to throw:
//   "Protocol error (Page.printToPDF): Target closed"
//
// Fix:
//   1. setContent() now uses waitUntil: 'domcontentloaded' — it returns as soon
//      as the HTML is parsed and the DOM is ready, without waiting for external
//      scripts or network activity to settle.
//   2. We rely entirely on our own `html[data-render-ready="true"]` attribute
//      (set by the exported HTML after Tailwind + fonts are ready) rather than
//      Puppeteer's network-idle heuristic.
//   3. page.on('error') and page.on('pageerror') are wired up so that any crash
//      or uncaught JS error in the page is logged and does not silently corrupt
//      the PDF pipeline.
//   4. The browser is guaranteed to be closed in a finally block even when the
//      page context crashes before pdf() is called.
// ---------------------------------------------------------------------------

export async function generatePdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-features=IsolateOrigins,site-per-process',
            // Allow the page to load external CDN resources (Tailwind, Google Fonts)
            // without triggering CORS / mixed-content blocks inside Puppeteer.
            '--disable-web-security',
            '--allow-running-insecure-content',
        ],
    });

    let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;

    try {
        page = await browser.newPage();

        // Track whether the page context has been destroyed so we can skip
        // operations (like pdf()) that would throw "Target closed".
        let pageTargetClosed = false;
        page.on('close',         () => { pageTargetClosed = true; });
        page.on('error',         (err) => {
            pageTargetClosed = true;
            console.error('Puppeteer page crash:', err);
        });
        page.on('pageerror',     (err: Error) => {
            // Log JS errors from within the page context (e.g. Tailwind CDN
            // issues) but do not abort — they are usually non-fatal for PDF output.
            console.warn('Puppeteer page JS error (non-fatal):', err.message);
        });

        await page.setViewport({ width: 1200, height: 1600 });

        // Keep individual operation timeouts generous but finite.
        page.setDefaultNavigationTimeout(120000);
        page.setDefaultTimeout(120000);

        // ── Step 1: parse the HTML ──────────────────────────────────────────
        // FIX: use 'domcontentloaded' only — do NOT use 'networkidle0'.
        // 'networkidle0' waits for all network requests to stop, which never
        // happens when the Tailwind CDN script is active (it keeps scanning the
        // DOM and making sub-requests).  'domcontentloaded' returns as soon as
        // the HTML is parsed, which is all Puppeteer needs before we start
        // waiting for our own readiness signal below.
        console.log('Generating PDF: Setting content...');
        await page.setContent(html, {
            waitUntil: 'domcontentloaded',
            timeout: 120000,
        });

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly during content load.');
        }

        // ── Step 2: wait for our custom readiness signal ────────────────────
        // The exported HTML sets `document.documentElement.dataset.renderReady
        // = 'true'` once Tailwind CDN has processed the DOM and fonts are loaded
        // (see exportDocument.ts buildHtmlShell).  We wait up to 90 s for this.
        console.log('Generating PDF: Waiting for readiness signal...');
        try {
            await page.waitForSelector('html[data-render-ready="true"]', { timeout: 90000 });
        } catch {
            console.warn('Readiness signal timed out after 90 s — proceeding anyway. ' +
                         'PDF may have incomplete Tailwind styles.');
        }

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly while waiting for readiness signal.');
        }

        // ── Step 3: wait for web fonts ──────────────────────────────────────
        console.log('Generating PDF: Waiting for fonts...');
        try {
            await page.evaluate(() => document.fonts.ready);
        } catch {
            console.warn('Font readiness check failed — proceeding anyway.');
        }

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly while waiting for fonts.');
        }

        // ── Step 4: generate the PDF ────────────────────────────────────────
        console.log('Generating PDF: Creating PDF buffer...');
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            timeout: 120000,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });

        console.log('Generating PDF: Success.');
        return Buffer.from(pdf);

    } catch (error) {
        console.error('Puppeteer PDF generation error:', error);
        throw error;
    } finally {
        // Always close the browser, even if the page context has already crashed.
        try {
            await browser.close();
        } catch (closeError) {
            console.warn('Browser close warning (non-fatal):', closeError);
        }
    }
}
