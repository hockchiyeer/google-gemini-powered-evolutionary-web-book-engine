import { When } from "@badeball/cypress-cucumber-preprocessor";

When("I click {string} on {string}", (locator_name, page_name) => {
  cy.clickOnTheElement(locator_name, page_name);
});

When("I click on {string} containing text {string} on {string}", (locator_name, value, page_name) => {
  cy.clickOnElementContainsText(locator_name, value, page_name);
});

When("I double click {string} on {string}", (locator_name, page_name) => {
  cy.doubleClickOnTheElement(locator_name, page_name);
});

When("I trigger click {string} on {string}", (locator_name, page_name) => {
  cy.clickUsingTrigger(locator_name, page_name);
});

When("I enter {string} in {string} on {string}", (value, locator_name, page_name) => {
  cy.enterTheValue(locator_name, page_name, value);
});

When("I select {string} in {string} drop-down list on {string}", (value, locator_name, page_name) => {
  cy.selectByValue(value, locator_name, page_name);
});
