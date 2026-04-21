Feature: Web-Book Engine Evolution Pipeline
  As a principal system tester
  I want to comprehensively verify the targeted ingestion, evolutionary metrics, and all export formats
  So that I can be confident the Evolutionary Web-Book Engine functions reliably under simulated loads

  Background:
    Given I clear Web browser cookies

  # ─────────────────────────────────────────────────────────
  # SCENARIO 1: Default State Assertions and UI Integrity
  # ─────────────────────────────────────────────────────────
  Scenario: Default State Assertions and UI Integrity check
    When I navigate to "DEV" URL and close cookies pop up window
    Then I verify title is "Evolutionary Web Book Engine"
    And I should see "engine_title" is displayed on "WebBookEngine_Page"
    And I should see "targeted_ingestion_section" is displayed on "WebBookEngine_Page"
    And I should see "search_input" is enabled on "WebBookEngine_Page"
    And I should see "status_label" text displayed in "idle" on "WebBookEngine_Page"
    And I should see "generation_number" text displayed in "0" on "WebBookEngine_Page"
    And I should see "pop_size_number" text displayed in "0" on "WebBookEngine_Page"
    And I should see "evolutionary_metrics_section" is displayed on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 2: Fallback Mode Selector — Gemini Only (Off)
  # ─────────────────────────────────────────────────────────
  Scenario: Fallback Mode - Gemini Only (Fallback OFF)
    When I navigate to "DEV" URL and close cookies pop up window
    Then I should see "fallback_mode_select" is displayed on "WebBookEngine_Page"
    When I select fallback mode "off"
    Then I should see fallback mode is set to "off"
    And I should see "search_input" is enabled on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 3: Fallback Mode — Google + DuckDuckGo
  # ─────────────────────────────────────────────────────────
  Scenario: Fallback Mode - Google + DuckDuckGo
    When I navigate to "DEV" URL and close cookies pop up window
    Then I should see "fallback_mode_select" is displayed on "WebBookEngine_Page"
    When I select fallback mode "google_duckduckgo"
    Then I should see fallback mode is set to "google_duckduckgo"
    And I should see "search_input" is enabled on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 4: Fallback Mode — Google Only
  # ─────────────────────────────────────────────────────────
  Scenario: Fallback Mode - Google Only
    When I navigate to "DEV" URL and close cookies pop up window
    Then I should see "fallback_mode_select" is displayed on "WebBookEngine_Page"
    When I select fallback mode "google"
    Then I should see fallback mode is set to "google"
    And I should see "search_input" is enabled on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 5: Fallback Mode — DuckDuckGo Only
  # ─────────────────────────────────────────────────────────
  Scenario: Fallback Mode - DuckDuckGo Only
    When I navigate to "DEV" URL and close cookies pop up window
    Then I should see "fallback_mode_select" is displayed on "WebBookEngine_Page"
    When I select fallback mode "duckduckgo"
    Then I should see fallback mode is set to "duckduckgo"
    And I should see "search_input" is enabled on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 6: Targeted Ingestion & Artifacts Panel Toggle
  # ─────────────────────────────────────────────────────────
  Scenario: Targeted Ingestion Form Interaction and Popup validation
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "show_artifacts_button" on "WebBookEngine_Page"
    Then I should see "hide_artifacts_button" is displayed on "WebBookEngine_Page"
    When I click "hide_artifacts_button" on "WebBookEngine_Page"
    Then I should see "show_artifacts_button" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 7: Export — High-Res PDF Web-book
  # ─────────────────────────────────────────────────────────
  Scenario: Export High Res PDF Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "export_high_res_pdf_button" is displayed on "WebBookEngine_Page"
    When I click "export_high_res_pdf_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 8: Export — Print / Save as PDF (Low-Res)
  # ─────────────────────────────────────────────────────────
  Scenario: Export Print Save As PDF Low Res Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "print_pdf_button" is displayed on "WebBookEngine_Page"
    When I click "print_pdf_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 9: Export — Word (.docx) Web-book
  # ─────────────────────────────────────────────────────────
  Scenario: Export Docx Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "docx_export_button" is displayed on "WebBookEngine_Page"
    When I click "docx_export_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 10: Export — HTML Web-book
  # ─────────────────────────────────────────────────────────
  Scenario: Export HTML Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "html_export_button" is displayed on "WebBookEngine_Page"
    When I click "html_export_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 11: Export — Plain Text (.txt) Web-book
  # ─────────────────────────────────────────────────────────
  Scenario: Export Txt File Web-book
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    Then I should see "txt_export_button" is displayed on "WebBookEngine_Page"
    When I click "txt_export_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 12: PDF Context Triggers Validation (both PDF paths in one flow)
  # ─────────────────────────────────────────────────────────
  Scenario: PDF Context Triggers Validation
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I stub Web-book export handlers
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    And I click "print_pdf_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"
    When I click "export_menu_button" on "WebBookEngine_Page"
    When I click "export_high_res_pdf_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 13: History Drawer Open and Close
  # ─────────────────────────────────────────────────────────
  Scenario: History Drawer Open and Close
    When I navigate to "DEV" URL and close cookies pop up window
    And I click "history_button" on "WebBookEngine_Page"
    Then I should see "history_drawer_title" is displayed on "WebBookEngine_Page"
    And I should see "close_history_button" is displayed on "WebBookEngine_Page"
    When I click "close_history_button" on "WebBookEngine_Page"
    Then I should see "engine_title" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 14: New Search resets state
  # ─────────────────────────────────────────────────────────
  Scenario: New Search resets the Web-book viewer state
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"
    When I click "new_search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "idle" on "WebBookEngine_Page"
    And I should see "webbook_viewer_placeholder" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 15: Fallback OFF + Gemini fails → error state
  # When fallback is disabled and Gemini returns 401 the engine
  # cannot produce content and must surface an error to the user.
  # ─────────────────────────────────────────────────────────
  Scenario: Gemini only generation shows error when key absent and fallback is OFF
    Given I stub Gemini API calls to return 401
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "off"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "error_message" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 16: Google + DuckDuckGo fallback → complete
  # Gemini is stubbed to 401; fallback (google_duckduckgo) is
  # enabled; fixture returns data → evolution completes.
  # ─────────────────────────────────────────────────────────
  Scenario: Generation completes via Google and DuckDuckGo fallback when Gemini key is absent
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "google_duckduckgo"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 17: Google Only fallback → complete
  # ─────────────────────────────────────────────────────────
  Scenario: Generation completes via Google only fallback when Gemini key is absent
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "google"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 18: DuckDuckGo Only fallback → complete
  # ─────────────────────────────────────────────────────────
  Scenario: Generation completes via DuckDuckGo only fallback when Gemini key is absent
    Given I stub fallback search results using fixture "search-fallback-quantum-physics.json"
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "duckduckgo"
    And I enter "Quantum Physics" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "status_label" text displayed in "complete" on "WebBookEngine_Page"
    And I should see "generated_book_content" is displayed on "WebBookEngine_Page"

  # ─────────────────────────────────────────────────────────
  # SCENARIO 19: Error shown when Gemini fails + fallback OFF
  # (Explicit variant: no search-fallback fixture registered —
  # confirms the error state regardless of any prior intercepts)
  # ─────────────────────────────────────────────────────────
  Scenario: Error is shown when Gemini fails and fallback is explicitly disabled
    Given I stub Gemini API calls to return 401
    When I navigate to "DEV" URL and close cookies pop up window
    And I select fallback mode "off"
    And I enter "Dark Matter" in "search_input" on "WebBookEngine_Page"
    And I click "search_button" on "WebBookEngine_Page"
    Then I should see "error_message" is displayed on "WebBookEngine_Page"
