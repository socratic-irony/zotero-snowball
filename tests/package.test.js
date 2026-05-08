const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { XMLParser } = require("./xml-test-utils");

const ROOT = path.resolve(__dirname, "..");

test("manifest includes Zotero-required add-on compatibility metadata", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8")
  );
  const packageJSON = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );

  const zotero = manifest.applications?.zotero;

  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.version, packageJSON.version);
  assert.equal(zotero?.id, "snowball-sources@socratic-irony.github.io");
  assert.equal(zotero?.strict_min_version, "9.0");
  assert.match(zotero?.strict_max_version, /^9\./);
  assert.match(zotero?.update_url, /^https:\/\//);
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
  assert.match(source, /<\?xml-stylesheet href="chrome:\/\/snowball-sources\/content\/snowballDialog\.css"/);
});

test("review dialog asset references resolve inside the XPI source tree", () => {
  const dialogPath = path.join(ROOT, "src/chrome/content/snowballDialog.xhtml");
  const dialogDir = path.dirname(dialogPath);
  const source = fs.readFileSync(dialogPath, "utf8");

  const references = [
    ...source.matchAll(/<script\s+src="([^"]+)"/g),
    ...source.matchAll(/<\?xml-stylesheet\s+href="([^"]+)"/g)
  ].map(match => match[1]);

  // Local-content references must use the registered chrome:// URL so that
  // they resolve identically whether the document is loaded via chrome://
  // or rootURI://.
  const localRefs = references.filter(href =>
    href.startsWith("chrome://snowball-sources/content/")
  );

  assert.deepEqual(localRefs.sort(), [
    "chrome://snowball-sources/content/snowballDialog.css",
    "chrome://snowball-sources/content/snowballDialog.js",
    "chrome://snowball-sources/content/modules/log.js",
    "chrome://snowball-sources/content/modules/errors.js",
    "chrome://snowball-sources/content/modules/http.js",
    "chrome://snowball-sources/content/modules/util.js",
    "chrome://snowball-sources/content/modules/ranking.js",
    "chrome://snowball-sources/content/modules/openalex.js",
    "chrome://snowball-sources/content/modules/semanticscholar.js",
    "chrome://snowball-sources/content/modules/zoteroItems.js"
  ].sort());

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
  ].map(match => match[1])
    .filter(href => !href.startsWith("chrome://"));

  for (const href of references) {
    assert.doesNotMatch(href, /\.\.\//, `Parent traversal is not safe in chrome content: ${href}`);
  }
});

test("review dialog script avoids HTML string injection in the XML chrome document", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "src/chrome/content/snowballDialog.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});
