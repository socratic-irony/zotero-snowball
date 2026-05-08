/* global Zotero, Services, Cc, Ci, SnowballSourcesPlugin */

var SnowballSources;
var SnowballChromeHandle;

function log(message) {
  Zotero.debug(`Snowball Sources: ${message}`);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log(`Starting ${version}`);

  try {
    const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Ci.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    SnowballChromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "snowball-sources", "chrome/content/"]
    ]);

    // Load modules in dependency order. log/errors/http are foundations,
    // util feeds ranking/openalex, and the controller comes last.
    const modules = [
      "chrome/content/modules/log.js",
      "chrome/content/modules/errors.js",
      "chrome/content/modules/http.js",
      "chrome/content/modules/util.js",
      "chrome/content/modules/ranking.js",
      "chrome/content/modules/openalex.js",
      "chrome/content/modules/zoteroItems.js",
      "chrome/content/snowball.js"
    ];
    for (const path of modules) {
      try {
        Services.scriptloader.loadSubScript(rootURI + path);
      } catch (error) {
        log(`Failed to load ${path}: ${error}`);
        throw error;
      }
    }

    SnowballSources = new SnowballSourcesPlugin({ id, version, rootURI });
    await SnowballSources.startup();
  } catch (error) {
    log(`startup failed: ${error?.stack || error}`);
    // Surface a one-time alert so the user knows the plugin didn't load
    // cleanly, instead of the menu items appearing dead.
    try {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win?.alert?.(
        "Snowball Sources failed to start. Please check the Zotero debug log."
      );
    } catch (_) { /* ignore */ }
  }
}

function onMainWindowLoad({ window }) {
  if (SnowballSources) {
    SnowballSources.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (SnowballSources) {
    SnowballSources.removeFromWindow(window);
  }
}

function shutdown() {
  log("Shutting down");

  if (SnowballSources) {
    SnowballSources.shutdown();
    SnowballSources = null;
  }

  if (SnowballChromeHandle) {
    SnowballChromeHandle.destruct();
    SnowballChromeHandle = null;
  }
}

function uninstall() {
  log("Uninstalled");
}
