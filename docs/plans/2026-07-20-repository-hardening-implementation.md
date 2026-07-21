# Repository Hardening Implementation Plan

> Execute each task test-first. A task is complete only after its focused tests and the repository checks pass and it has received specification and code-quality review.

**Goal:** Implement the repository hardening design without runtime dependencies or regressions in Zotero 7–9 compatibility.

**Architecture:** Keep privileged Zotero integration at the edges. Move pure validation, candidate-store, and rendering decisions into small modules with Node-testable APIs. Reuse the current module-loading pattern rather than adding a bundler.

**Tooling:** JavaScript, XUL/XHTML, CSS, Fluent, Node's test runner, ESLint, Prettier, TypeScript check mode, shell XPI build/validation.

---

### Task 1: Replace and verify icon assets

**Files:**

- Create: `src/chrome/content/icons/snowball.svg`
- Modify: `src/chrome/content/snowball.js`
- Modify: `src/manifest.json`
- Modify: `tests/package.test.js`
- Replace: `src/icons/icon-48.png`, `src/icons/icon-96.png`
- Remove: obsolete toolbar raster duplicates in `src/icons/` and `src/chrome/content/icons/`

**Steps:**

1. Add failing package tests for a 20×20 transparent `context-fill` SVG, native CSS sizing, alpha-bearing manifest PNGs, and absence of obsolete toolbar raster references.
2. Run the focused test and confirm the new assertions fail.
3. Draw the simplified 20×20 snowball mark, wire it into the toolbar, and generate transparent manifest rasters from the canonical vector.
4. Run package tests, format checks, and build/asset validation.

### Task 2: Harden HTTP and PDF egress

**Files:**

- Modify: `src/chrome/content/modules/http.js`
- Modify: `src/chrome/content/modules/zoteroItems.js`
- Modify: `src/chrome/content/snowball.js`
- Modify: `src/prefs.js`
- Modify: `tests/security.test.js`
- Modify: `tests/snowball-modules.test.js`

**Steps:**

1. Add failing tests for redirect revalidation, redirect limits, response byte/depth/node caps, abort-listener cleanup, public-HTTPS PDF validation, and the opt-in default.
2. Confirm focused failures.
3. Implement manual redirect handling and bounded JSON reads with stable errors.
4. Implement public HTTPS PDF validation and switch automatic PDF downloads off by default.
5. Run the focused tests and static checks.

### Task 3: Correct and bound provider behavior

**Files:**

- Modify: `src/chrome/content/modules/semanticscholar.js`
- Modify: `src/chrome/content/modules/openalex.js`
- Modify: `tests/snowball-modules.test.js`
- Modify: `tests/security.test.js`

**Steps:**

1. Add failing tests for the explicit SPECTER2 field, serialized/rate-spaced requests, finite bounded vectors, bounded OpenAlex abstracts/authors/strings, and merged location metadata.
2. Confirm focused failures.
3. Add a shared per-instance Semantic Scholar request queue and strict embedding normalization.
4. Bound OpenAlex normalization and merge best metadata/PDF locations.
5. Run focused and full module tests.

### Task 4: Extract and fix candidate ingestion

**Files:**

- Create: `src/chrome/content/modules/candidateStore.js`
- Modify: `src/chrome/content/snowballDialog.xhtml`
- Modify: `src/chrome/content/snowballDialog.js`
- Modify: `src/chrome/content/modules/zoteroItems.js`
- Create: `tests/candidate-store.test.js`
- Modify: `tests/snowball-modules.test.js`

**Steps:**

1. Add failing tests proving duplicate merges rescore and retain richer metadata, fuzzy scans are bounded/indexed, and title-only library matches require year or creator corroboration and reuse cached lookups.
2. Confirm failures.
3. Extract a pure candidate store and route dialog ingestion through it.
4. Strengthen and cache existing-library matching; ensure provider and direction tags are applied to existing items.
5. Run focused tests and the full check.

### Task 5: Pipeline seed/citation work

**Files:**

- Modify: `src/chrome/content/modules/openalex.js`
- Modify: `src/chrome/content/snowballDialog.js`
- Modify: `tests/snowball-modules.test.js`
- Create or modify: `tests/candidate-store.test.js`

**Steps:**

1. Add failing async tests showing citation candidates can arrive before all seeds resolve, concurrency stays within the configured worker bound, and later seed context rescoring remains correct.
2. Confirm failures.
3. Implement bounded pipeline/fan-in helpers with abort propagation.
4. Rebuild seed context and rescore stored candidates as seeds resolve.
5. Run focused concurrency tests repeatedly, then the full check.

### Task 6: Extract efficient accessible table rendering

**Files:**

- Create: `src/chrome/content/modules/dialogTable.js`
- Modify: `src/chrome/content/snowballDialog.xhtml`
- Modify: `src/chrome/content/snowballDialog.css`
- Modify: `src/chrome/content/snowballDialog.js`
- Create: `tests/dialog-table.test.js`
- Modify: `tests/plugin-controller.test.js`

**Steps:**

1. Add failing source/DOM-harness tests for keyed row reuse, bounded visible rendering with progressive expansion, batched streaming updates, keyboard sorting/selection/splitter control, `aria-sort`, and modal overlay labelling.
2. Confirm failures.
3. Extract a table renderer with a keyed cache and visible-window limit.
4. Add keyboard and ARIA behavior through explicit event listeners.
5. Run focused tests and the full check.

### Task 7: Localize UI and remove inline handlers

**Files:**

- Modify: `src/chrome/content/snowballDialog.xhtml`
- Modify: `src/chrome/content/snowballPrefs.xhtml`
- Modify: `src/chrome/content/snowballDialog.js`
- Modify: `src/chrome/content/snowballPrefs.js`
- Modify: `src/chrome/locale/en-US/snowball.ftl`
- Modify: `tests/plugin-controller.test.js`
- Modify: `tests/package.test.js`

**Steps:**

1. Add failing tests that user-facing strings are Fluent-backed, no inline command/load/click handlers remain, API keys use password/autocomplete protections, and toolbar text has an explicit localized tooltip.
2. Confirm failures.
3. Add Fluent messages and replace hard-coded attributes/text.
4. Bind all handlers from JavaScript and preserve current behavior.
5. Run localization, XML, and controller tests.

### Task 8: Correct documentation and add final gates

**Files:**

- Modify: `README.md`
- Modify: `docs/todo.md`
- Modify: `package.json`
- Modify: `tests/package.test.js`

**Steps:**

1. Add failing assertions for the canonical add-on ID/proxy filename, Node version, current Semantic Scholar/OpenAlex behavior, and opt-in PDF privacy language.
2. Confirm failures.
3. Update README and replace obsolete TODO content with the maintained roadmap/state.
4. Add a coverage command using Node's built-in coverage output; do not add a runtime dependency.
5. Run documentation tests, the complete check, build, and XPI validation.

### Task 9: Final integration review

1. Run independent specification review against the design and this plan.
2. Run independent code-quality/security review of the complete diff.
3. Address findings test-first.
4. Run `npm run check`, `npm run build`, `npm run validate:xpi`, and focused icon inspection.
5. Summarize changes, verification, and any intentionally deferred risks for the user.
