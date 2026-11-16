'use strict';
// Add-on settings. Exposes globalThis.AIOSSettings.
//
// There is no server to configure any more: the add-on talks to Qdrant (the
// index) and Ollama (the embedder) itself, so those two endpoints are the
// connection settings. Read from storage on every call — the options page and
// the search page both write settings, and a cached copy goes stale mid-session.
(function () {
  const KEY = 'settings';

  const DEFAULTS = {
    // services
    qdrantUrl: 'http://127.0.0.1:6333',
    qdrantApiKey: '',
    collection: 'ai_omnisearch',
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
    embedBatch: 64,
    // ranking
    keywordWeights: { subject: 8, from: 4, to: 2, body: 1 },
    rrfK: 60,
    candidatesMultiplier: 3,
  };

  // Keys the 2.x add-on stored for the Python search server. Dropped on load so
  // a stale serverUrl cannot be mistaken for a Qdrant endpoint.
  const LEGACY_KEYS = ['serverUrl', 'apiKey'];

  let cache = null;

  function normalise(raw) {
    const merged = { ...DEFAULTS, ...(raw || {}) };
    // Nested object: never let a stale flat value win over the defaults.
    merged.keywordWeights = { ...DEFAULTS.keywordWeights, ...((raw && raw.keywordWeights) || {}) };
    for (const key of LEGACY_KEYS) delete merged[key];
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

  async function ensure() {
    const data = await messenger.storage.local.get(KEY);
    const merged = normalise(data && data[KEY]);
    const stored = data && data[KEY];
    // Re-write when the stored copy still carries legacy keys, otherwise the
    // options page would keep showing a server URL that no longer means anything.
    const stale = stored && LEGACY_KEYS.some((k) => k in stored);
    if (!stored || stale) await messenger.storage.local.set({ [KEY]: merged });
    cache = merged;
    return merged;
  }

  globalThis.AIOSSettings = { DEFAULTS, get, save, ensure, normalise };
})();
