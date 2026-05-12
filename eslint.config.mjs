// Flat config (ESLint 9+). Project-level rules are intentionally conservative
// so this lands cleanly on existing vibe-coded source. Tightening lives in
// docs/CQ_SECURITY_ROADMAP.md and should be ratcheted up one rule at a time.

import js from "@eslint/js";
import globals from "globals";
import promisePlugin from "eslint-plugin-promise";
import nPlugin from "eslint-plugin-n";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "build/**",
      "node_modules/**",
      "**/*.xpi",
      "src/icons/**",
      "src/chrome/content/icons/**"
    ]
  },

  // Baseline — all JS files
  js.configs.recommended,

  // Chrome / plugin runtime code (loaded by Zotero's subscript loader).
  // These files declare top-level `var SnowballX = {...}` on purpose so the
  // module becomes a global on the shared subscript scope. Each file has its
  // own `/* global */` directive listing what it consumes; we only declare
  // here the things that *aren't* covered by those (i.e. things the dialog /
  // prefs / snowball.js scripts use without a per-file `/* global */` line).
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // XPCOM / Mozilla platform — used by dialog/prefs/snowball.js which
        // don't carry their own `/* global */` directive.
        Components: "readonly",
        Cc: "readonly",
        Ci: "readonly",
        Cu: "readonly",
        Cr: "readonly",
        ChromeUtils: "readonly",
        Services: "readonly",
        XPCOMUtils: "readonly",
        Zotero: "readonly",
        Zotero_File_Interface: "readonly",
        // Top-level helpers exported from errors.js (not on any namespace).
        formatUserError: "readonly",
        // Snowball modules — needed for the dialog/prefs scripts which omit
        // a per-file `/* global */` line. The module files that *define*
        // these have `no-redeclare` turned off below, so the declaration
        // and the global both coexist.
        // SnowballSources is mutated by bootstrap.js (it accumulates module
        // refs as the subscript loader pulls each file in), so it's writable.
        SnowballSources: "writable",
        SnowballSourcesPlugin: "readonly",
        SnowballLog: "readonly",
        SnowballError: "readonly",
        SnowballHTTP: "readonly",
        SnowballUtil: "readonly",
        SnowballRanking: "readonly",
        SnowballZoteroItems: "readonly",
        SnowballDialog: "readonly",
        SnowballPrefs: "readonly",
        OpenAlexProvider: "readonly",
        SemanticScholarProvider: "readonly"
      }
    },
    plugins: {
      promise: promisePlugin
    },
    rules: {
      // Correctness
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "off", // top-level `var` here is the export mechanism
      "prefer-const": "warn",
      // `vars: "local"` so top-level `var SnowballX = {...}` exports and
      // Zotero-API lifecycle functions (install/uninstall/startup/shutdown)
      // aren't flagged as unused.
      "no-unused-vars": [
        "error",
        {
          vars: "local",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      // Per-file `/* global */` directives intentionally re-list config
      // globals for documentation; that's fine, not a redeclaration bug.
      "no-redeclare": "off",
      "no-implicit-globals": "off",
      "no-undef": "error",
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-shadow": "warn",
      "no-return-await": "error",
      "no-throw-literal": "error",
      "no-promise-executor-return": "error",
      "require-atomic-updates": "off", // noisy on the dialog state mutations
      "consistent-return": "off",

      // Security-ish nudges (cheap, no plugin)
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",

      // Promise hygiene
      "promise/no-new-statics": "error",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",
      "promise/catch-or-return": "off", // too noisy on fire-and-forget UI handlers
      "promise/always-return": "off"
    }
  },

  // Special-case: prefs.js is a Mozilla preferences file. `pref(...)` is the
  // only call and it's defined by the platform, not by us.
  {
    files: ["src/prefs.js"],
    languageOptions: {
      globals: {
        pref: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off"
    }
  },

  // Test files — CommonJS, run under node:test.
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs
      }
    },
    plugins: {
      n: nPlugin,
      promise: promisePlugin
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "n/no-process-exit": "error",
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },

  // Build scripts.
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    plugins: { n: nPlugin },
    rules: {
      "n/no-process-exit": "off",
      "no-console": "off"
    }
  },

  // Always last — turn off any stylistic rules that fight Prettier.
  prettier
];
