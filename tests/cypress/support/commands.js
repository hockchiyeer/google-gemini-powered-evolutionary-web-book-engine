// ***********************************************
// Custom Cypress commands for Evolutionary Web-Book Engine
// ***********************************************

import { objects } from '../e2e/pageObjects';

const SEARCH_FALLBACK_ROUTE = '**/api/search-fallback*';
const PDF_EXPORT_ROUTE = '**/__pdf';
const PICSUM_ROUTE = '**/picsum.photos/**';
const FONTS_GOOGLE_ROUTE = '**/fonts.googleapis.com/**';
const FONTS_GSTATIC_ROUTE = '**/fonts.gstatic.com/**';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeComparableText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isXPath(locatorStr) {
  return locatorStr.startsWith('//') || locatorStr.startsWith('(') || locatorStr.startsWith('./');
}

function getElement(page_name, locator_name) {
  const page = page_name.replace(/\s+/g, '');
  const locatorKey = locator_name.replaceAll(' ', '_');

  if (!objects[page] || !objects[page][locatorKey]) {
    throw new Error(`Locator not found: objects['${page}']['${locatorKey}']`);
  }

  const locatorStr = objects[page][locatorKey];
  return isXPath(locatorStr)
    ? cy.xpath(locatorStr, { timeout: 60000 })
    : cy.get(locatorStr, { timeout: 60000 });
}

/**
 * Returns a minimal window-like object whose properties satisfy every code
 * path inside printWebBook() (the iframe-based print route).
 * The stub must be synchronous so Cypress stubs can return it from win.open().
 */
function buildPrintWindowStub() {
  const stubDoc = {
    title: '',
    head: { querySelector: () => null },
    open: () => { },
    write: () => { },
    close: () => { },
    createElement: () => ({ style: {}, setAttribute: () => { }, click: () => { } }),
  };
  const stub = {
    document: stubDoc,
    history: { replaceState: () => { } },
    focus: () => { },
    print: () => { },
    close: () => { },
    onload: null,
    addEventListener: () => { },
    removeEventListener: () => { },
    clearTimeout: () => { },
    setTimeout: (_fn, _ms) => 0,
  };
  // printWebBook sets iframeWindow.onload then immediately calls iframeDoc.close(),
  // so we fire the onload callback synchronously once it is assigned.
  return new Proxy(stub, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop === 'onload' && typeof value === 'function') {
        try { value(); } catch (_) { }
      }
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Registered Cypress Commands
// ---------------------------------------------------------------------------

Cypress.Commands.add('injectFakeOneTrustCookies', () => {
  const bannerClosed = 'OptanonAlertBoxClosed';
  const bannerClosedValue = new Date(Date.now() - 60 * 1000).toISOString();
  Cypress.on('window:before:load', (win) => {
    const hostname = win.location.hostname || '';
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    const domainPart = hostname ? `; domain=${hostname}` : '';
    win.document.cookie = `${bannerClosed}=${bannerClosedValue}; expires=${expires}; path=/${domainPart}`;
  });
});

Cypress.Commands.add('clearCookiesAndStorage', () => {
  cy.clearAllCookies();
  cy.clearAllSessionStorage();
  cy.clearAllLocalStorage();
});

/**
 * Stubs ALL Gemini API calls to immediately return HTTP 401 (unauthorised).
 * This forces the evolution service into its fallback path without any real
 * network round-trip, keeping generation scenarios fast and deterministic.
 *
 * The stub matches the Google Generative Language REST endpoint used by
 * @google/genai in the app's server-side route handler.
 */
Cypress.Commands.add('stubGeminiApiToFail', () => {
  cy.intercept('POST', '**/generativelanguage.googleapis.com/**', {
    statusCode: 401,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        code: 401,
        message: 'API_KEY_INVALID — stubbed by Cypress test harness',
        status: 'UNAUTHENTICATED',
      },
    },
  }).as('geminiApiStub');
});

// Stub /api/search-fallback so the test never hits a real server.
// Also automatically stubs the Gemini API to fail so the fallback path
// is exercised without waiting for a real (slow) 401/403 from Google.
Cypress.Commands.add('mockFallbackSearchResults', (fixtureName = 'search-fallback-quantum-physics.json') => {
  // Stub Gemini first so it fails fast → triggers fallback immediately
  cy.stubGeminiApiToFail();

  cy.fixture(fixtureName).then((payload) => {
    cy.intercept('GET', SEARCH_FALLBACK_ROUTE, {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).as('searchFallback');
  });
});

/**
 * Stubs ALL Web-book export handlers so no real network / print / download
 * calls leave the browser during tests:
 *
 *   POST /__pdf               → 200 application/pdf   (High-Res PDF via Puppeteer server)
 *   GET  picsum.photos/**     → 200 image/png 1×1     (chapter images, prevents inlining hang)
 *   GET  fonts.googleapis.com → 204                   (Google Fonts CSS)
 *   GET  fonts.gstatic.com    → 204                   (Google Fonts woff2)
 *   document.createElement    → iframe with stubbed contentWindow (Print/Save PDF path)
 *   URL.createObjectURL       → 'blob:mock-export'    (DOCX / HTML / TXT download trigger)
 *   URL.revokeObjectURL       → no-op
 *   HTMLAnchorElement#click   → no-op                 (hidden anchor download trigger)
 */
Cypress.Commands.add('stubWebBookExportHandlers', () => {

  // ── High-Res PDF endpoint ────────────────────────────────────────────────
  cy.intercept('POST', PDF_EXPORT_ROUTE, {
    statusCode: 200,
    headers: { 'content-type': 'application/pdf' },
    body: 'MOCK_PDF',
  }).as('pdfExport');

  // ── Chapter images (picsum) – return a 1×1 PNG fixture ──────────────────
  // Using cy.fixture ensures the PNG bytes are correctly transmitted as binary.
  cy.fixture('1x1.png', 'binary').then((pngBinary) => {
    cy.intercept('GET', PICSUM_ROUTE, {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: pngBinary,
    }).as('picsumImage');
  });

  // ── Google Fonts – return empty so export HTML builds without CDN delays ─
  cy.intercept('GET', FONTS_GOOGLE_ROUTE, { statusCode: 204, body: '' }).as('googleFontsCSS');
  cy.intercept('GET', FONTS_GSTATIC_ROUTE, { statusCode: 204, body: '' }).as('googleFontsFiles');

  // ── Window / download stubs ──────────────────────────────────────────────
  cy.window().then((win) => {
    const realCreateElement = win.document.createElement.bind(win.document);
    cy.stub(win.document, 'createElement')
      .callsFake((tagName, ...args) => {
        const element = realCreateElement(tagName, ...args);

        if (String(tagName).toLowerCase() === 'iframe') {
          Object.defineProperty(element, 'contentWindow', {
            configurable: true,
            value: buildPrintWindowStub(),
          });
        }

        return element;
      })
      .as('documentCreateElement');

    // downloadBlob() calls URL.createObjectURL → creates <a> → anchor.click()
    cy.stub(win.URL, 'createObjectURL').returns('blob:mock-export').as('createObjectURL');
    cy.stub(win.URL, 'revokeObjectURL').as('revokeObjectURL');

    // Intercept the programmatic anchor click that triggers the browser download
    cy.stub(win.HTMLAnchorElement.prototype, 'click').as('downloadClick');
  });
});

// ── Navigation ──────────────────────────────────────────────────────────────

Cypress.Commands.add('navigateToUrlAndCloseCookiesPopUp', (url) => {
  cy.viewport(2560, 1440);
  const targetUrl = Cypress.env(url) || Cypress.env('baseUrl') || url;
  cy.visit(targetUrl);
  cy.document().its('readyState').should('eq', 'complete');
});

Cypress.Commands.add('navigateToUrlWithoutClosingCookiesPopUp', (url) => {
  cy.viewport(2560, 1440);
  const targetUrl = Cypress.env(url) || Cypress.env('baseUrl') || url;
  cy.visit(targetUrl);
  cy.document().its('readyState').should('eq', 'complete');
});

// ── Interactions ────────────────────────────────────────────────────────────

Cypress.Commands.add('clickOnTheElement', (locator_name, page_name) => {
  getElement(page_name, locator_name).first().click({ force: true });
});

Cypress.Commands.add('clickOnElementContainsText', (locator_name, value, page_name) => {
  getElement(page_name, locator_name).contains(value, { timeout: 60000 }).click({ force: true });
});

Cypress.Commands.add('doubleClickOnTheElement', (locator_name, page_name) => {
  getElement(page_name, locator_name).first().dblclick({ force: true });
});

Cypress.Commands.add('clickUsingTrigger', (locator_name, page_name) => {
  getElement(page_name, locator_name).first().trigger('click');
});

Cypress.Commands.add('enterTheValue', (locator_name, page_name, value) => {
  const selectedValue = Cypress.env(value) || value;
  getElement(page_name, locator_name).clear({ force: true }).type(selectedValue, { force: true });
});

Cypress.Commands.add('selectByValue', (value, locator_name, page_name) => {
  getElement(page_name, locator_name).select(value);
});

// ── Assertions ──────────────────────────────────────────────────────────────

Cypress.Commands.add('verifyElementIsVisible', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('be.visible');
});

Cypress.Commands.add('verifyTextIsDisplayed', (locator_name, page_name, value) => {
  const expectedValue = normalizeComparableText(value);
  getElement(page_name, locator_name).should(($el) => {
    const candidates = [
      normalizeComparableText($el.text()),
      normalizeComparableText($el.val()),
      normalizeComparableText($el.html()),
    ];
    expect(
      candidates.some((c) => c.includes(expectedValue)),
      `Expected ${locator_name} on ${page_name} to contain "${value}"`
    ).to.be.true;
  });
});

Cypress.Commands.add('verifyTextIsNotDisplayed', (locator_name, page_name, value) => {
  const expectedValue = normalizeComparableText(value);
  getElement(page_name, locator_name).should(($el) => {
    const candidates = [
      normalizeComparableText($el.text()),
      normalizeComparableText($el.val()),
      normalizeComparableText($el.html()),
    ];
    expect(
      candidates.some((c) => c.includes(expectedValue)),
      `Expected ${locator_name} on ${page_name} NOT to contain "${value}"`
    ).to.be.false;
  });
});

Cypress.Commands.add('verifyElementIsEnabled', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('not.be.disabled');
});

Cypress.Commands.add('verifyElementIsDisabled', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('be.disabled');
});

Cypress.Commands.add('verifyTitle', (title) => {
  const expectedTitle = normalizeComparableText(title);
  cy.title().should((actualTitle) => {
    expect(normalizeComparableText(actualTitle)).to.include(expectedTitle);
  });
});

Cypress.Commands.add('pageContainsText', (text) => {
  cy.contains(text.trim(), { timeout: 60000 }).should('exist');
});

Cypress.Commands.add('pageNotContainsText', (text) => {
  cy.contains(text.trim(), { timeout: 60000 }).should('not.exist');
});

// ── Fallback-mode helpers ───────────────────────────────────────────────────

Cypress.Commands.add('selectFallbackMode', (modeValue) => {
  cy.get('select#fallback-mode', { timeout: 10000 }).select(modeValue);
});

Cypress.Commands.add('verifyFallbackModeSelected', (modeValue) => {
  cy.get('select#fallback-mode', { timeout: 10000 }).should('have.value', modeValue);
});
