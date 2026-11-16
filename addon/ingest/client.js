'use strict';
// Server API client. Exposes globalThis.AIOSClient.
//
// Reads connection settings from storage.local on every call (no cache to go
// stale when the user edits the options page), retries once on transient
// network errors, and serializes writes through a promise chain so ingest
// batches, event updates and deletes stay ordered. All write endpoints are
// idempotent server-side (deterministic point IDs, hash-based skip), so a
// retry can never double-index anything.
(function () {
  const DEFAULT_TIMEOUT_MS = 300000; // 5 min: embedding a 250-doc batch is slow
  const SEARCH_TIMEOUT_MS = 120000;
  const RETRY_DELAY_MS = 1500;

  async function getConnection() {
    const r = await messenger.storage.local.get('settings');
    const s = (r && r.settings) || {};
    const serverUrl = (s.serverUrl || 'http://localhost:8342').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers['X-API-Key'] = s.apiKey;
    return { serverUrl, headers };
  }

  async function request(method, path, body, opts = {}) {
    const { serverUrl, headers } = await getConnection();
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const doFetch = () =>
      fetch(serverUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

    let resp;
    try {
      resp = await doFetch();
    } catch (e) {
      if (e && e.name === 'AbortError') throw e; // timeout: no retry
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      resp = await doFetch();
    }
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const b = await resp.json();
        if (b && b.detail) detail = b.detail;
      } catch (_) {
        /* not JSON */
      }
      const err = new Error(detail);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  // One write in flight at a time; failures never break the chain.
  let writeChain = Promise.resolve();
  function queued(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  }

  globalThis.AIOSClient = {
    // reads
    health: () => request('GET', '/health', undefined, { timeoutMs: 10000 }),
    version: () => request('GET', '/version', undefined, { timeoutMs: 10000 }),
    stats: () => request('GET', '/stats', undefined, { timeoutMs: 30000 }),
    has: (items) => request('POST', '/has', { items }, { timeoutMs: 60000 }),
    reconcile: (live) => request('POST', '/reconcile', { live }, { timeoutMs: 300000 }),
    search: (query, opts) =>
      request('POST', '/search', { query, ...opts }, { timeoutMs: SEARCH_TIMEOUT_MS }),

    // writes (serialized)
    ingest: (docs) => queued(() => request('POST', '/ingest', { docs })),
    delete: (items) => queued(() => request('POST', '/delete', { items })),
    removeFolder: (items) => queued(() => request('POST', '/folders/remove', { items })),
    clear: () => queued(() => request('POST', '/clear', undefined, { timeoutMs: 60000 })),
  };
})();
