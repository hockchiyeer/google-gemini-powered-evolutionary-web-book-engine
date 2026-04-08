Feature: Web-Book Engine Evolution Pipeline
  As a principal system tester
  I want to comprehensively verify the targeted ingestion, evolutionary metrics, and PDF generation
  So that I can be confident the Evolutionary Web-Book Engine functions reliably under simulated loads

  Background:
    Given I clear Web browser cookies

  Scenario: Default State Assertions and UI Integrity check
    When I navigate to "DEV" URL and close cookies pop up window
    Then I verify title is "Evolutionary Web-Book Engine"
    And I should see "engine_title" is displayed on "WebBookEngine_Page"
    And I should see "targeted_ingestion_section" is displayed on "WebBookEngine_Page"
    And I should see "search_input" is enabled on "WebBookEngine_Page"
    And I should see "status_label" text displayed in "IDLE" on "WebBookEngine_Page"
    And I should see "generation_number" text displayed in "0" on "WebBookEngine_Page"
    And I should see "pop_size_number" text displayed in "0" on "WebBookEngine_Page"

  Scenario: Targeted Ingestion Form Interaction and Popup validation
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    # Status should change to SEARCHING or similar as the network starts capturing
    Then I should see "search_input" is disabled on "WebBookEngine_Page"
    And I should see "status_label" text displayed in "SEARCHING" on "WebBookEngine_Page"
    # Show artifacts panel interaction
    When I click "show_artifacts_button" on "WebBookEngine_Page"
    Then I should see "hide_artifacts_button" is displayed on "WebBookEngine_Page"
    # Depending on network availability, we let it process momentarily
    When I click "hide_artifacts_button" on "WebBookEngine_Page"

  # We mock or bypass the heavy generation in a real E2E environment 
  # but here we test the button triggers
  Scenario: PDF Context Triggers Validation
    When I navigate to "DEV" URL and close cookies pop up window
    And I click "print_pdf_button" on "WebBookEngine_Page"
    # Clicking print pdf usually opens a window or calls window.print
    # Just asserting the button doesn't crash the page
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"
    When I click "export_high_res_pdf_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"
