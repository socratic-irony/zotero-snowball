// Ambient declarations for the Zotero / XPCOM / Mozilla-platform globals that
// our chrome scripts touch at runtime. This is intentionally partial — we
// only declare what we actually call. Add more here as `tsc --checkJs`
// surfaces real gaps; do NOT preemptively widen.
//
// Anything declared `any` is a "we know we use this, we're not promising
// shape yet" placeholder. Tightening these is a roadmap item.

declare var Zotero: any;
declare var Zotero_File_Interface: any;

declare var Components: any;
declare var Cc: any;
declare var Ci: any;
declare var Cu: any;
declare var Cr: any;
declare var ChromeUtils: any;
declare var Services: any;
declare var XPCOMUtils: any;

// Mozilla preferences file API (src/prefs.js)
declare function pref(name: string, value: string | number | boolean): void;

// Snowball modules — each file declares one global of this shape.
declare var SnowballSources: any;
declare var SnowballSourcesPlugin: any;
declare var SnowballLog: any;
declare var SnowballError: any;
declare var SnowballHTTP: any;
declare var SnowballUtil: any;
declare var SnowballRanking: any;
declare var SnowballZoteroItems: any;
declare var SnowballDialog: any;
declare var SnowballPrefs: any;
declare var OpenAlexProvider: any;
declare var SemanticScholarProvider: any;

// Subscript loader handle used by bootstrap.js
declare var SnowballChromeHandle: any;
