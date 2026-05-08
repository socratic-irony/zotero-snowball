# Zotero Snowball Sources TODO

Paused on 2026-05-07 with the repo at `/Users/main/Sync_Code/zotero-snowball`.

## Current State

- The original MVP spec is saved as `spec.md`.
- The plugin scaffold and MVP implementation exist under `src/`.
- Current package/manifest version is `0.1.3`.
- Latest build artifact is `build/snowball-sources-0.1.3.xpi`.
- Unit/static tests pass locally with `npm test`.
- Build passes with `npm run build`.
- XHTML/manifest syntax checks passed:
  - `python3 -m json.tool src/manifest.json`
  - `xmllint --noout src/chrome/content/snowballDialog.xhtml`

## Bugs Already Fixed

- Zotero 9 install failure:
  - Fixed by adding `applications.zotero.update_url` to `src/manifest.json`.
  - Zotero 9.0.3 rejected the add-on without it, despite the original spec saying to omit it.
- Blank right-click menu entry:
  - Fixed by loading the Fluent file into already-open main windows during plugin startup.
  - `SnowballSourcesPlugin.startup()` now calls `addToAllWindows()`.
- Tiny sliver dialog:
  - Reproduced through Computer Use.
  - Fixed the window sizing path by registering plugin chrome content and opening the dialog with explicit dimensions.
  - `src/bootstrap.js` now calls `aomStartup.registerChrome(...)`.
  - `src/chrome/content/snowball.js` now opens `chrome://snowball-sources/content/snowballDialog.xhtml` with `width=1100,height=720`.

## Current Blocker

After installing/reinstalling `0.1.3`, Zotero creates a normal-sized review window, but the window body is still blank.

Observed through Computer Use:

- Window is normal sized.
- Window title is still empty in the accessibility tree.
- Accessibility tree contains only window controls and an empty container:
  - no toolbar,
  - no table,
  - no details panel,
  - no visible XUL content.

This means the window shell is opening, but the document content is not successfully loading or rendering.

## Important Environment Notes

- Zotero app: `/Applications/Zotero.app`
- Active profile used during debugging:
  `/Users/main/Library/Application Support/Zotero/Profiles/99p3kghe.default`
- Debug log used during the session:
  `/tmp/zotero-snowball-debug.log`
- Computer Use can inspect/click Zotero. Call `mcp__computer_use__get_app_state` before interacting with Zotero in a new assistant turn.
- This folder is not currently a git repository.

## Install State Got Weird

During the last iteration, the profile's add-on state became inconsistent:

- The running Zotero process still showed the Snowball context-menu item.
- But `extensions.json` no longer listed `snowball-sources@example.com`.
- The profile `extensions/` directory did not contain `snowball-sources@example.com.xpi`.

I attempted to set up a development proxy file:

```text
/Users/main/Library/Application Support/Zotero/Profiles/99p3kghe.default/extensions/snowball-sources@example.com
```

with contents:

```text
/Users/main/Sync_Code/zotero-snowball/src/
```

Zotero still did not list the add-on in `extensions.json` after restart. Next session should first restore a clean, deterministic install state before debugging the blank dialog further.

## Next Debugging Steps

1. Get Zotero into a clean add-on state.
   - Quit Zotero completely.
   - Remove any stale Snowball install/proxy files from the profile.
   - Reinstall `build/snowball-sources-0.1.3.xpi` through Zotero's Add-ons UI, or create a separate development profile and install via source proxy there.
   - Confirm `extensions.json` lists `snowball-sources@example.com` at version `0.1.3`.

2. Relaunch Zotero with debug logging.

```bash
/Applications/Zotero.app/Contents/MacOS/zotero -ZoteroDebugText -jsconsole
```

3. Trigger `Snowball Sources for Selected Item(s)` from the item context menu.

4. Inspect debug output immediately for:
   - `chrome://snowball-sources/content/snowballDialog.xhtml`
   - `Snowball Sources`
   - `NS_ERROR`
   - `XML Parsing Error`
   - `ReferenceError`
   - `TypeError`
   - `Failed to load`

5. If logs are still silent, create a minimal smoke dialog to isolate document loading:
   - Add `src/chrome/content/smoke.xhtml` with only a root XUL window, one label, and no external CSS/scripts/localization.
   - Temporarily open that instead of `snowballDialog.xhtml`.
   - If smoke renders, reintroduce:
     - stylesheet PIs,
     - `linkset` localization,
     - `script src`,
     - HTML table/aside,
     one at a time.

6. Strong candidate causes to test next:
   - The dialog's custom XHTML/XUL structure may need a `<dialog>` child like Zotero's `selectItemsDialog.xhtml` and `searchDialog.xhtml`.
   - The stylesheet PI `href="snowballDialog.css"` may not resolve from registered chrome content; try `chrome://snowball-sources/content/snowballDialog.css`.
   - `data-l10n-id` on the root window or the `<linkset>` may be failing before content renders; temporarily remove localization from the dialog document.
   - The `onload="SnowballDialog.init(window.arguments[0])"` handler may throw before layout paints; temporarily remove `onload` and use static text only.

## Useful Commands

```bash
npm test
npm run build
npm run validate:xpi
python3 -m json.tool src/manifest.json
xmllint --noout src/chrome/content/snowballDialog.xhtml
unzip -l build/snowball-sources-0.1.3.xpi | sed -n '1,80p'
```

Inspect current installed add-on metadata:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/Users/main/Library/Application Support/Zotero/Profiles/99p3kghe.default/extensions.json')
data = json.loads(p.read_text())
for addon in data.get('addons', []):
    if addon.get('id') == 'snowball-sources@example.com':
        print(json.dumps(addon, indent=2))
PY
```

## Files Most Relevant Next Session

- `src/bootstrap.js`
- `src/chrome/content/snowball.js`
- `src/chrome/content/snowballDialog.xhtml`
- `src/chrome/content/snowballDialog.js`
- `src/chrome/content/snowballDialog.css`
- `tests/bootstrap.test.js`
- `tests/plugin-controller.test.js`
- `tests/package.test.js`
