import { Then } from "@badeball/cypress-cucumber-preprocessor";

Then("I should see {string} is displayed on {string}", (locator_name, page_name) => {
  cy.verifyElementIsVisible(locator_name, page_name);
});

Then("I should see {string} is disabled on {string}", (locator_name, page_name) => {
  cy.verifyElementIsDisabled(locator_name, page_name);
});

Then("I should see {string} is enabled on {string}", (locator_name, page_name) => {
  cy.verifyElementIsEnabled(locator_name, page_name);
});

Then("I should see {string} text displayed in {string} on {string}", (value, locator_name, page_name) => {
  let expectedValue = Cypress.env(value) || value;
  cy.verifyTextIsDisplayed(locator_name, page_name, expectedValue);
});

Then("I should not see {string} text displayed in {string} on {string}", (value, locator_name, page_name) => {
  let expectedValue = Cypress.env(value) || value;
  cy.verifyTextIsNotDisplayed(locator_name, page_name, expectedValue);
});

Then("I verify title is {string}", (title) => {
  cy.verifyTitle(title);
});

Then("I verify the text {string} is displayed on the webpage", (text) => {
  let expectedText = Cypress.env(text) || text;
  cy.pageContainsText(expectedText);
});

Then("I verify the text {string} is not displayed on the webpage", (text) => {
  let expectedText = Cypress.env(text) || text;
  cy.pageNotContainsText(expectedText);
});
