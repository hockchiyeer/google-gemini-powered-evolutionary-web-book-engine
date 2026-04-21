import { Given, When } from "@badeball/cypress-cucumber-preprocessor";

Given('I navigate to {string} URL and close cookies pop up window', (env) => {
  cy.navigateToUrlAndCloseCookiesPopUp(env);
});

Given('I navigate to {string} URL without closing cookies pop up window', (env) => {
  cy.navigateToUrlWithoutClosingCookiesPopUp(env);
});

Given('I clear Web browser cookies', () => {
  cy.clearCookiesAndStorage();
});

Given('I inject fake OneTrust cookies to the Web browser', () => {
  cy.injectFakeOneTrustCookies();
});

Given('I stub fallback search results using fixture {string}', (fixtureName) => {
  cy.mockFallbackSearchResults(fixtureName);
});

/** Stub Gemini API at the Given level (explicit scenario control) */
Given('I stub Gemini API calls to return 401', () => {
  cy.stubGeminiApiToFail();
});

Given('I stub Web-book export handlers', () => {
  cy.stubWebBookExportHandlers();
});

// Note: Given() definitions match on And/When/Then/But clauses too in cucumber-preprocessor,
// so no duplicate When alias is needed for "I stub Web-book export handlers".
