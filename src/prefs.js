pref("extensions.snowballSources.openAlexAPIKey", "");
pref("extensions.snowballSources.semanticScholarAPIKey", "");
pref("extensions.snowballSources.maxSeeds", 50);
pref("extensions.snowballSources.maxForwardPerSeed", 100);
pref("extensions.snowballSources.maxBackwardPerSeed", 100);
pref("extensions.snowballSources.maxCandidatesTotal", 500);
pref("extensions.snowballSources.includeForward", true);
pref("extensions.snowballSources.includeBackward", true);
pref("extensions.snowballSources.defaultSort", "relevance");
pref("extensions.snowballSources.skipAlreadyInLibrary", true);
pref("extensions.snowballSources.requestTimeoutMs", 30000);

// Default minimum citation count below which a candidate is hidden by the
// runtime filter. 0 means show everything.
pref("extensions.snowballSources.minCitedBy", 0);

// Attach open-access PDFs to newly-added items when OpenAlex supplies a
// `best_oa_location.pdf_url`. The download happens in the background after
// the bulk-add transaction commits, so the dialog isn't blocked on
// network I/O. Set to false to disable.
pref("extensions.snowballSources.downloadPDFs", true);

// Persisted dialog UI state (window size + splitter width). Stored as JSON.
pref("extensions.snowballSources.uiState", "");

// Column visibility in the review dialog. Title is always shown so a
// candidate can't appear as a row of empty cells. Each pref toggles a
// single column.
pref("extensions.snowballSources.columns.score",     true);
pref("extensions.snowballSources.columns.direction", true);
pref("extensions.snowballSources.columns.status",    true);
pref("extensions.snowballSources.columns.year",      true);
pref("extensions.snowballSources.columns.authors",   true);
pref("extensions.snowballSources.columns.venue",     true);
pref("extensions.snowballSources.columns.citedBy",   true);

// Score weight customization. Defaults match SnowballRanking.WEIGHTS.
// Range 0–2.0 with 0.05 step in the prefs UI.
pref("extensions.snowballSources.weights.text",          1.00);
pref("extensions.snowballSources.weights.bibCoupling",   0.20);
pref("extensions.snowballSources.weights.coCitation",    0.15);
pref("extensions.snowballSources.weights.authorOverlap", 0.10);
pref("extensions.snowballSources.weights.titleTrigram",  0.08);
pref("extensions.snowballSources.weights.citation",      0.10);
pref("extensions.snowballSources.weights.embedding",     0.40);
