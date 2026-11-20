'use strict';
// The addon's own search stack, loaded into Node. Exposes loadRuntime().
//
// The point of this file is that the CLI must not re-implement the ranking: a
// second copy of the BM25 field weights, the RRF constant and the "Latest"
// ordering would drift from the addon the first time either changed. So the
// real files — lib/http.js, lib/settings.js, lib/text.js, lib/qdrant.js,
// lib/ollama.js, lib/search.js — are evaluated here exactly as the test harness
// evaluates them, and only the two things they expect from Thunderbird are
// stubbed:
//
//   messenger.storage.local   settings, read from ~/.config/sarvasearch/config.json
//   SarvaIndex.ensureReady    a no-op: the collection already exists, and the
//                             CLI never builds an index
//
// Everything else talks to the live services over HTTP, which is what the addon
// does too.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADDON = path.join(__dirname, '..', '..', 'addon');
const LIB_ORDER = ['http', 'settings', 'text', 'qdrant', 'ollama', 'search'];

function configPath() {
  if (process.env.SARVA_CONFIG) return process.env.SARVA_CONFIG;
  return path.join(os.homedir(), '.config', 'sarvasearch', 'config.json');
}

function readConfig() {
  const file = configPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

// A settings blob plus a storage stub, so SarvaSettings.get() merges it over the
// addon's real DEFAULTS instead of inventing its own defaults.
function installStubMessenger(settings) {
  const store = { settings };
  globalThis.messenger = {
    storage: {
      local: {
        get: async (key) => {
          if (key == null) return { ...store };
          if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
          if (Array.isArray(key)) {
            return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
          }
          return {};
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (key) => delete store[key],
      },
    },
  };
  return store;
}

function evalAddonLib(name) {
  const file = path.join(ADDON, 'lib', `${name}.js`);
  const code = fs.readFileSync(file, 'utf8');
  // Indirect eval: runs in global scope, which is how these IIFEs publish
  // themselves (globalThis.SarvaX) in Thunderbird too.
  (0, eval)(code);
}

let cached = null;

function loadRuntime(overrides = {}) {
  const settings = { ...readConfig(), ...overrides };
  installStubMessenger(settings);
  for (const name of LIB_ORDER) evalAddonLib(name);
  globalThis.SarvaIndex = {
    ensureReady: async () => {},
    invalidate: () => {},
  };
  cached = { addonDir: ADDON, settings };
  return {
    SarvaHttp: globalThis.SarvaHttp,
    SarvaSettings: globalThis.SarvaSettings,
    SarvaText: globalThis.SarvaText,
    SarvaQdrant: globalThis.SarvaQdrant,
    SarvaOllama: globalThis.SarvaOllama,
    SarvaSearch: globalThis.SarvaSearch,
    configPath: configPath(),
    rawConfig: settings,
  };
}

module.exports = { loadRuntime, configPath, readConfig, LIB_ORDER, ADDON, get lastLoaded() { return cached; } };
