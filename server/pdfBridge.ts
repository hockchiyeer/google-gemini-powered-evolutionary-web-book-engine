import puppeteer from 'puppeteer';

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
            // Allow the page to load external Tailwind and font assets.
            '--disable-web-security',
            '--allow-running-insecure-content',
        ],
    });

    let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;

    try {
        page = await browser.newPage();

        // Track whether the page context has been destroyed so we can avoid
        // calling PDF generation on a closed target.
        let pageTargetClosed = false;
        page.on('close', () => { pageTargetClosed = true; });
        page.on('error', (err) => {
            pageTargetClosed = true;
            console.error('Puppeteer page crash:', err);
        });
        page.on('pageerror', (err: Error) => {
            // Surface page-side JS issues without aborting the PDF path.
            console.warn('Puppeteer page JS error (non-fatal):', err.message);
        });

        await page.setViewport({ width: 1200, height: 1600 });

        // Keep individual operation timeouts generous but finite.
        page.setDefaultNavigationTimeout(120000);
        page.setDefaultTimeout(120000);

        console.log('Generating PDF: Setting content...');
        await page.setContent(html, {
            waitUntil: 'domcontentloaded',
            timeout: 120000,
        });

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly during content load.');
        }

        // Match the browser print dialog path so the server-side PDF picks up
        // the same print-specific layout and color rules.
        await page.emulateMediaType('print');

        console.log('Generating PDF: Waiting for readiness signal...');
        try {
            await page.waitForSelector('html[data-render-ready="true"]', { timeout: 90000 });
        } catch {
            console.warn('Readiness signal timed out after 90 s; proceeding anyway. PDF may have incomplete Tailwind styles.');
        }

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly while waiting for readiness signal.');
        }

        console.log('Generating PDF: Waiting for fonts...');
        try {
            await page.evaluate(() => document.fonts.ready);
        } catch {
            console.warn('Font readiness check failed; proceeding anyway.');
        }

        if (pageTargetClosed) {
            throw new Error('Page context closed unexpectedly while waiting for fonts.');
        }

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
        try {
            await browser.close();
        } catch (closeError) {
            console.warn('Browser close warning (non-fatal):', closeError);
        }
    }
}
