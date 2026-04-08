export const WebBookEngine_Page = {
    // Selectors mapped to DOM elements on the WebBook Engine Page
    
    // Header & Global controls
    engine_title: "//h1[contains(text(), 'EVOLUTIONARY WEB-BOOK ENGINE')]",
    history_button: "button[title='View search and generation history']", // CSS Selector

    // Control Sidebar Forms
    targeted_ingestion_section: "//h2[contains(text(), 'Targeted Ingestion')]", // XPath Selector
    search_input: "textarea[placeholder='Search for topic...']", // CSS Selector
    search_button: "button[title='Execute evolutionary synthesis pipeline']", // CSS Selector
    new_search_button: "//button[contains(., 'New Search')]", // XPath Selector

    // Metrics Panel
    evolutionary_metrics_section: "//h2[contains(text(), 'Evolutionary Metrics')]", // XPath Selector
    status_label: "div.space-y-6 > div.flex.justify-between.items-end > span.font-mono", // CSS Selector
    generation_number: "//span[text()='Generation']/following-sibling::span", // XPath Selector
    pop_size_number: "//span[text()='Pop. Size']/following-sibling::span", // XPath Selector
    show_artifacts_button: "//button[contains(., 'Show Artifacts')]", // XPath Selector
    hide_artifacts_button: "//button[contains(., 'Hide Artifacts')]", // XPath Selector

    // PDF Export / Action controls
    print_pdf_button: "button[title='Print layout to PDF']", // CSS Selector
    export_high_res_pdf_button: "button[title='Export high res PDF']", // CSS Selector
    
    // Viewer
    webbook_viewer_placeholder: "//h3[contains(text(), 'Evolutionary Web-Book Engine Ready')]", // XPath Selector
    generated_book_title: "div.book-layout-container h1.book-title", // CSS Selector
    generated_book_content: "div.book-layout-container", // CSS Selector
};
