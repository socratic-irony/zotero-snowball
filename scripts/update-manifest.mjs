#!/usr/bin/env node
/**
 * Regenerates the top-level updates.json that Zotero polls for new versions.
 *
 * Usage:
 *   node scripts/update-manifest.mjs \
 *     --version 0.2.1 \
 *     --xpi-url https://github.com/socratic-irony/zotero-snowball/releases/download/v0.2.1/snowball-sources-0.2.1.xpi \
 *     --sha256 <hex>
 *
 * Behavior:
 *   - Reads `src/manifest.json` to get the add-on id, strict_min/max version.
 *   - Reads existing `updates.json` if present and merges this version into
 *     `addons[<id>].updates`, deduplicating by `version`.
 *   - Sorts updates ascending by semver so Zotero picks the highest correctly.
 *   - Writes `updates.json` at the repo root with two-space indentation.
 *
 * Format reference:
 *   https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf
 *   https://extensionworkshop.com/documentation/manage/updating-your-extension/
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.replace(/^--/, "");
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

function semverCmp(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function isSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || ""));
}

function isHttpsUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function isSha256(s) {
  return typeof s === "string" && /^[a-f0-9]{64}$/i.test(s);
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  const args = parseArgs(process.argv);

  const version = String(args.version || "").trim();
  const xpiURL = String(args["xpi-url"] || "").trim();
  const sha = String(args.sha256 || "").trim();

  if (!isSemver(version)) throw new Error(`Invalid --version: ${version}`);
  if (!isHttpsUrl(xpiURL)) throw new Error(`Invalid --xpi-url (must be https): ${xpiURL}`);
  if (!isSha256(sha)) throw new Error(`Invalid --sha256: must be 64 hex chars`);

  const manifestPath = path.join(repoRoot, "src", "manifest.json");
  const manifest = loadJSON(manifestPath);
  const z = manifest.applications?.zotero;
  if (!z?.id) throw new Error("manifest.json is missing applications.zotero.id");
  if (!z.strict_min_version) throw new Error("manifest.json is missing strict_min_version");

  const updatesPath = path.join(repoRoot, "updates.json");
  let updatesDoc = { addons: {} };
  if (fs.existsSync(updatesPath)) {
    try {
      updatesDoc = loadJSON(updatesPath);
      if (!updatesDoc || typeof updatesDoc !== "object") {
        updatesDoc = { addons: {} };
      }
      if (!updatesDoc.addons || typeof updatesDoc.addons !== "object") {
        updatesDoc.addons = {};
      }
    } catch {
      // Corrupt or empty: rebuild from scratch.
      updatesDoc = { addons: {} };
    }
  }

  const entry = updatesDoc.addons[z.id] || {};
  const existing = Array.isArray(entry.updates) ? entry.updates : [];

  const newUpdate = {
    version,
    update_link: xpiURL,
    update_hash: `sha256:${sha.toLowerCase()}`,
    applications: {
      zotero: {
        strict_min_version: z.strict_min_version,
        ...(z.strict_max_version ? { strict_max_version: z.strict_max_version } : {})
      }
    }
  };

  // Replace any existing entry for this exact version, then sort ascending.
  const merged = existing.filter((u) => u.version !== version).concat(newUpdate);
  merged.sort((a, b) => semverCmp(a.version, b.version));

  updatesDoc.addons[z.id] = { updates: merged };

  fs.writeFileSync(updatesPath, JSON.stringify(updatesDoc, null, 2) + "\n", "utf8");

  console.log(
    `updates.json: wrote ${merged.length} entr${merged.length === 1 ? "y" : "ies"} for ${z.id}; latest=${merged[merged.length - 1].version}`
  );
}

try {
  main();
} catch (error) {
  console.error(`update-manifest: ${error.message}`);
  process.exit(1);
}
