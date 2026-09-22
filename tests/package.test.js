const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { XMLParser } = require("./xml-test-utils");

const ROOT = path.resolve(__dirname, "..");

function runtimeTextFiles(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeTextFiles(entryPath));
    else if (/\.(?:css|ftl|js|json|xhtml|xml)$/.test(entry.name)) files.push(entryPath);
  }

  return files;
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function inspectRGBA8PNG(filePath) {
  const source = fs.readFileSync(filePath);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(source.subarray(0, signature.length), signature, `${filePath} must be a PNG`);

  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  const bitDepth = source[24];
  const colorType = source[25];
  const compressedRows = [];

  for (let offset = signature.length; offset < source.length;) {
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (type === "IDAT") compressedRows.push(source.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }

  assert.equal(bitDepth, 8, `${filePath} must use 8-bit channels`);
  assert.equal(colorType, 6, `${filePath} must store RGBA pixels, not an opaque RGB canvas`);

  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const filteredRows = zlib.inflateSync(Buffer.concat(compressedRows));
  let previousRow = Buffer.alloc(rowLength);
  let inputOffset = 0;
  let hasTransparentPixel = false;
  let hasVisiblePixel = false;

  for (let y = 0; y < height; y += 1) {
    const filter = filteredRows[inputOffset];
    inputOffset += 1;
    const row = Buffer.alloc(rowLength);

    for (let x = 0; x < rowLength; x += 1) {
      const byte = filteredRows[inputOffset + x];
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previousRow[x];
      const upLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0;

      if (filter === 0) row[x] = byte;
      else if (filter === 1) row[x] = (byte + left) & 0xff;
      else if (filter === 2) row[x] = (byte + up) & 0xff;
      else if (filter === 3) row[x] = (byte + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (byte + paethPredictor(left, up, upLeft)) & 0xff;
      else assert.fail(`${filePath} uses unsupported PNG filter ${filter}`);
    }

    for (let x = 3; x < rowLength; x += bytesPerPixel) {
      hasTransparentPixel ||= row[x] < 255;
      hasVisiblePixel ||= row[x] > 0;
    }

    previousRow = row;
    inputOffset += rowLength;
  }

  return { width, height, hasTransparentPixel, hasVisiblePixel };
}

test("manifest includes Zotero-required add-on compatibility metadata", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));
  const packageJSON = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  const zotero = manifest.applications?.zotero;

  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.version, packageJSON.version);
  assert.equal(zotero?.id, "snowball-sources@socratic-irony.github.io");
  assert.equal(zotero?.strict_min_version, "9.0");
  assert.match(zotero?.strict_max_version, /^9\./);
  assert.match(zotero?.update_url, /^https:\/\//);
});

test("API key fields conceal values and disable autocomplete", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/chrome/content/snowballPrefs.xhtml"), "utf8");

  for (const id of ["pref-openAlexAPIKey", "pref-semanticScholarAPIKey"]) {
    const input = source.match(new RegExp(`<html:input\\b[^>]*\\bid="${id}"[^>]*/>`))?.[0];
    assert.ok(input, `${id} must be present in the preferences document`);
    assert.match(input, /\btype="password"(?:\s|\/?>)/);
    assert.match(input, /\bautocomplete="off"(?:\s|\/?>)/);
  }
});

test("inline event handlers are replaced with lifecycle and button listeners", () => {
  const documents = [
    {
      document: "src/chrome/content/snowballDialog.xhtml",
      script: "src/chrome/content/snowballDialog.js",
      commandButtons: ["snowball-stop", "snowball-cancel", "snowball-add-selected"]
    },
    {
      document: "src/chrome/content/snowballPrefs.xhtml",
      script: "src/chrome/content/snowballPrefs.js",
      commandButtons: [
        "snowball-prefs-cancel",
        "snowball-prefs-save",
        "snowball-prefs-save-anyway"
      ],
      clickButtons: ["snowball-weights-reset"]
    }
  ];

  for (const entry of documents) {
    const documentSource = fs.readFileSync(path.join(ROOT, entry.document), "utf8");
    const scriptSource = fs.readFileSync(path.join(ROOT, entry.script), "utf8");

    assert.doesNotMatch(
      documentSource,
      /\bon[a-z]+\s*=/i,
      `${entry.document} has an inline handler`
    );
    assert.match(scriptSource, /window\.addEventListener\(\s*["']load["'][\s\S]*?once\s*:\s*true/);
    assert.match(scriptSource, /window\.arguments\[0\]/);

    for (const id of entry.commandButtons || []) {
      assert.match(
        scriptSource,
        new RegExp(`getElementById\\("${id}"\\)[\\s\\S]*?addEventListener\\("command"`)
      );
    }
    for (const id of entry.clickButtons || []) {
      assert.match(
        scriptSource,
        new RegExp(`getElementById\\("${id}"\\)[\\s\\S]*?addEventListener\\("click"`)
      );
    }
  }
});

test("toolbar uses a native-size transparent context-painted SVG", () => {
  const iconPath = path.join(ROOT, "src/chrome/content/icons/snowball.svg");
  assert.ok(fs.existsSync(iconPath), "canonical toolbar SVG must exist");

  const source = fs.readFileSync(iconPath, "utf8");
  const root = XMLParser.parse(source).root;

  assert.equal(root.name, "svg");
  assert.equal(root.attributes.width, "20");
  assert.equal(root.attributes.height, "20");
  assert.equal(root.attributes.viewBox, "0 0 20 20");
  assert.equal(root.attributes.fill, "none", "SVG canvas must be transparent");
  assert.match(source, /fill="context-fill"/, "visible geometry must inherit Zotero's color");
  assert.doesNotMatch(source, /\b(?:fill|stroke)="(?:#[0-9a-f]{3,8}|black|white|rgb\()/i);
});

test("toolbar CSS uses the canonical SVG with Zotero context paint at 20px", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/chrome/content/snowball.js"), "utf8");

  assert.match(
    source,
    /list-style-image:\s*url\("chrome:\/\/snowball-sources\/content\/icons\/snowball\.svg"\)/
  );
  assert.match(source, /\.toolbarbutton-icon\s*{[^}]*\bwidth:\s*20px;/s);
  assert.match(source, /\.toolbarbutton-icon\s*{[^}]*\bheight:\s*20px;/s);
  assert.match(source, /-moz-context-properties:\s*fill,\s*fill-opacity;/);
  assert.match(source, /\bfill:\s*currentColor;/);
});

test("manifest artwork has real alpha transparency at declared dimensions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src/manifest.json"), "utf8"));

  for (const [declaredSize, relativePath] of Object.entries(manifest.icons)) {
    const iconPath = path.join(ROOT, "src", relativePath);
    assert.ok(fs.existsSync(iconPath), `manifest icon must resolve: ${relativePath}`);

    const icon = inspectRGBA8PNG(iconPath);
    assert.equal(icon.width, Number(declaredSize));
    assert.equal(icon.height, Number(declaredSize));
    assert.ok(icon.hasTransparentPixel, `${relativePath} must contain transparent pixels`);
    assert.ok(icon.hasVisiblePixel, `${relativePath} must contain visible artwork`);
  }
});

test("obsolete duplicated toolbar rasters and references are absent", () => {
  const obsoleteAssets = [
    "src/chrome/content/icons/toolbar-16.png",
    "src/chrome/content/icons/toolbar-32.png",
    "src/icons/toolbar-16.png",
    "src/icons/toolbar-32.png"
  ];

  for (const relativePath of obsoleteAssets) {
    assert.equal(
      fs.existsSync(path.join(ROOT, relativePath)),
      false,
      `${relativePath} is obsolete`
    );
  }

  for (const filePath of runtimeTextFiles(path.join(ROOT, "src"))) {
    const runtimeSource = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(
      runtimeSource,
      /toolbar-(?:16|32)\.png/,
      `${path.relative(ROOT, filePath)} references an obsolete toolbar raster`
    );
  }
});

test("review dialog declares Zotero-compatible window layout and stylesheets", () => {
  const dialogPath = path.join(ROOT, "src/chrome/content/snowballDialog.xhtml");
  const source = fs.readFileSync(dialogPath, "utf8");
  const doc = XMLParser.parse(source);
  const root = doc.root;

  assert.equal(root.name, "window");
  assert.equal(root.attributes.title, "Snowball Sources");
  // The XUL <window> root must NOT have `display: flex` forced via inline
  // style: it overrides the toolkit window's default layout and causes the
  // dialog body to render blank in Zotero 9.
  assert.doesNotMatch(root.attributes.style || "", /display:\s*flex/);
  // Localization must not be attached to the root <window>: the linkset that
  // defines the FTL bundle is a child element, so Fluent throws before paint
  // when it tries to resolve a root-level data-l10n-id, blanking the dialog.
  assert.equal(root.attributes["data-l10n-id"], undefined);
  assert.equal(root.attributes["data-l10n-attrs"], undefined);
  assert.match(source, /<\?xml-stylesheet href="chrome:\/\/global\/skin\/"/);
  assert.match(
    source,
    /<\?xml-stylesheet href="chrome:\/\/snowball-sources\/content\/snowballDialog\.css"/
  );
});

test("review dialog asset references resolve inside the XPI source tree", () => {
  const dialogPath = path.join(ROOT, "src/chrome/content/snowballDialog.xhtml");
  const dialogDir = path.dirname(dialogPath);
  const source = fs.readFileSync(dialogPath, "utf8");

  const references = [
    ...source.matchAll(/<script\s+src="([^"]+)"/g),
    ...source.matchAll(/<\?xml-stylesheet\s+href="([^"]+)"/g)
  ].map((match) => match[1]);

  // Local-content references must use the registered chrome:// URL so that
  // they resolve identically whether the document is loaded via chrome://
  // or rootURI://.
  const localRefs = references.filter((href) =>
    href.startsWith("chrome://snowball-sources/content/")
  );

  assert.deepEqual(
    localRefs.sort(),
    [
      "chrome://snowball-sources/content/snowballDialog.css",
      "chrome://snowball-sources/content/snowballDialog.js",
      "chrome://snowball-sources/content/modules/log.js",
      "chrome://snowball-sources/content/modules/errors.js",
      "chrome://snowball-sources/content/modules/http.js",
      "chrome://snowball-sources/content/modules/util.js",
      "chrome://snowball-sources/content/modules/ranking.js",
      "chrome://snowball-sources/content/modules/openalex.js",
      "chrome://snowball-sources/content/modules/semanticscholar.js",
      "chrome://snowball-sources/content/modules/zoteroItems.js",
      "chrome://snowball-sources/content/modules/candidateStore.js",
      "chrome://snowball-sources/content/modules/candidateView.js"
    ].sort()
  );

  for (const href of localRefs) {
    const localPath = href.replace("chrome://snowball-sources/content/", "");
    assert.ok(
      fs.existsSync(path.resolve(dialogDir, localPath)),
      `Dialog asset reference does not exist: ${href}`
    );
  }
});

test("review dialog chrome document does not reference assets outside registered content", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "src/chrome/content/snowballDialog.xhtml"),
    "utf8"
  );
  const references = [
    ...source.matchAll(/<script\s+src="([^"]+)"/g),
    ...source.matchAll(/<\?xml-stylesheet\s+href="([^"]+)"/g)
  ]
    .map((match) => match[1])
    .filter((href) => !href.startsWith("chrome://"));

  for (const href of references) {
    assert.doesNotMatch(href, /\.\.\//, `Parent traversal is not safe in chrome content: ${href}`);
  }
});

test("review dialog script avoids HTML string injection in the XML chrome document", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/chrome/content/snowballDialog.js"), "utf8");

  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test("dialog and prefs scripts do not use window.alert / confirm / prompt", () => {
  // These render with the ugly "[JavaScript Application]" window header.
  // The dialog and prefs use the in-dialog toast and inline confirm panel
  // instead. Keep this guard so we don't regress.
  const targets = ["src/chrome/content/snowballDialog.js", "src/chrome/content/snowballPrefs.js"];
  for (const rel of targets) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const fn of ["window.alert", "window.confirm", "window.prompt"]) {
      assert.doesNotMatch(
        text,
        new RegExp(fn.replace(".", "\\.") + "\\s*\\("),
        `${rel} must not call ${fn}() — use the in-dialog toast instead`
      );
    }
  }
});
