import { objects } from '../e2e/pageObjects';

// Check if locator is XPath
function isXPath(locatorStr) {
  return locatorStr.startsWith('//') || locatorStr.startsWith('(') || locatorStr.startsWith('./');
}

// Get the actual Element from POM (Page Object Model)
function getElement(page_name, locator_name) {
  const page = page_name.replace(/\s+/g, '');
  const locatorKey = locator_name.replaceAll(' ', '_');

  if (!objects[page] || !objects[page][locatorKey]) {
    throw new Error(`Locator not found: objects['${page}']['${locatorKey}']`);
  }

  const locatorStr = objects[page][locatorKey];

  // Return a Cypress chainable
  if (isXPath(locatorStr)) {
    return cy.xpath(locatorStr, { timeout: 60000 });
  } else {
    return cy.get(locatorStr, { timeout: 60000 });
  }
}

function getRawLocator(page_name, locator_name) {
  const page = page_name.replace(/\s+/g, '');
  const locatorKey = locator_name.replaceAll(' ', '_');
  return objects[page][locatorKey];
}

Cypress.Commands.add('injectFakeOneTrustCookies', () => {
  var bannerClosed = 'OptanonAlertBoxClosed';
  var bannerClosedValue = new Date(Date.now() - 60 * 1000).toISOString();
  Cypress.on('window:before:load', (win) => {
    var hostname = win.location.hostname || '';
    var expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    var domainPart = hostname ? `; domain=${hostname}` : '';
    win.document.cookie = `${bannerClosed}=${bannerClosedValue}; expires=${expires}; path=/${domainPart}`;
  });
});

Cypress.Commands.add('clearCookiesAndStorage', () => {
  cy.clearAllCookies();
  cy.clearAllSessionStorage();
  cy.clearAllLocalStorage();
});

Cypress.Commands.add('navigateToUrlAndCloseCookiesPopUp', (url) => {
  cy.viewport(2560, 1440);
  const targetUrl = Cypress.env(url) || Cypress.env('baseUrl') || url;
  cy.visit(targetUrl);
  cy.document().its('readyState').should('eq', 'complete');
  // Generalized cookie closed implementation could be added here if specific popups are known
});

Cypress.Commands.add('navigateToUrlWithoutClosingCookiesPopUp', (url) => {
  cy.viewport(2560, 1440);
  const targetUrl = Cypress.env(url) || Cypress.env('baseUrl') || url;
  cy.visit(targetUrl);
  cy.document().its('readyState').should('eq', 'complete');
});

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
  getElement(page_name, locator_name).first().trigger("click");
});

Cypress.Commands.add('enterTheValue', (locator_name, page_name, value) => {
  let selectedValue = Cypress.env(value) || value;
  getElement(page_name, locator_name).clear({ force: true }).type(selectedValue, { force: true });
});

Cypress.Commands.add('selectByValue', (value, locator_name, page_name) => {
  getElement(page_name, locator_name).select(value);
});

Cypress.Commands.add('verifyElementIsVisible', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('be.visible');
});

Cypress.Commands.add('verifyTextIsDisplayed', (locator_name, page_name, value) => {
  getElement(page_name, locator_name).then(($element) => {
    const elementText = $element.text().trim();
    const elementValue = $element.val();
    const elementHtml = $element.html();

    if (elementText.includes(value)) {
      cy.wrap($element).should('include.text', value);
    } else if (elementValue && elementValue.toString().includes(value)) {
      cy.wrap($element).should('have.value', value);
    } else if (elementHtml && elementHtml.includes(value)) {
      cy.wrap($element).contains(value);
    } else {
      cy.wrap($element).should('include.text', value);
    }
  });
});

Cypress.Commands.add('verifyTextIsNotDisplayed', (locator_name, page_name, value) => {
  getElement(page_name, locator_name).should('not.include.text', value);
});

Cypress.Commands.add('verifyElementIsEnabled', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('not.be.disabled');
});

Cypress.Commands.add('verifyElementIsDisabled', (locator_name, page_name) => {
  getElement(page_name, locator_name).should('be.disabled');
});

Cypress.Commands.add('verifyTitle', (title) => {
  cy.title().should('include', title);
});

Cypress.Commands.add('pageContainsText', (text) => {
  cy.contains(text.trim(), { timeout: 60000 }).should("exist");
});

Cypress.Commands.add('pageNotContainsText', (text) => {
  cy.contains(text.trim(), { timeout: 60000 }).should("not.exist");
});
