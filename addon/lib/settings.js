'use strict';
// Add-on settings. Exposes globalThis.SarvaSettings.
//
// The add-on talks to Qdrant (the index) and Ollama (the embedder) directly,
// so those two endpoints are the connection settings. Read from storage on
// every call — the options page and the search page both write settings, and a
// cached copy goes stale mid-session.
(function () {
  const KEY = 'settings';

  const DEFAULTS = {
    // services
    qdrantUrl: 'http://127.0.0.1:6333',
    qdrantApiKey: '',
    collection: 'sarvasearch',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'nomic-embed-text',
    // search
    limit: 20,
    openIn: 'tab',
    mode: 'hybrid',
    // indexing
    includeSpamTrash: false,
    indexEncryptedBodies: false,
    bodyLimit: 4000,
    excludedAccounts: [],
    // bridge: the localhost daemon the add-on long-polls for "open this
    // message" requests (tools/bridge.js). Off would only be right on a shared
    // machine; enabled, it costs one hanging GET and nothing else.
    bridgeEnabled: true,
    bridgeUrl: 'http://127.0.0.1:8765',
    bridgeToken: '',
    embedBatch: 64,
    // ranking
    keywordWeights: { subject: 8, from: 4, to: 2, body: 1 },
    rrfK: 60,
    candidatesMultiplier: 3,
  };

  let cache = null;

  function normalise(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    // Nested object: never let a stale flat value win over the defaults.
    merged.keywordWeights = { ...DEFAULTS.keywordWeights, ...((raw && raw.keywordWeights) || {}) };
    merged.qdrantUrl = String(merged.qdrantUrl || DEFAULTS.qdrantUrl).replace(/\/+$/, '');
    merged.ollamaUrl = String(merged.ollamaUrl || DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    merged.collection = String(merged.collection || DEFAULTS.collection).trim() || DEFAULTS.collection;
    return merged;
  }

  async function get() {
    const data = await messenger.storage.local.get(KEY);
    cache = normalise(data && data[KEY]);
    return cache;
  }

  async function save(patch) {
    const current = await get();
    const next = normalise({ ...current, ...patch });
    await messenger.storage.local.set({ [KEY]: next });
    cache = next;
    return next;
  }

  // First run: write the defaults so the options page has something to show.
  async function ensure() {
    const data = await messenger.storage.local.get(KEY);
    const merged = normalise(data && data[KEY]);
    if (!data || !data[KEY]) await messenger.storage.local.set({ [KEY]: merged });
    cache = merged;
    return merged;
  }

  globalThis.SarvaSettings = { DEFAULTS, get, save, ensure, normalise };
})();
