'use strict';
// JSON-over-HTTP helper shared by every other module. Exposes globalThis.AIOSHttp.
//
// Two services are spoken to directly now (Qdrant and Ollama), so the retry
// and error-unwrapping rules live in one place:
//
// - timeouts are per-call (embedding a 250-doc batch is legitimately slow)
// - network errors are retried once; a 4xx never is
// - 5xx is retried (Qdrant returns 500 while a shard is still loading)
// - the error message carries the service's own text, not "HTTP 400":
//   Qdrant says {"status":{"error":"..."}} and Ollama says {"error":"..."}
(function () {
  const RETRY_DELAY_MS = 700;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function detailOf(text) {
    try {
      const body = JSON.parse(text);
      if (body && body.status && body.status.error) return body.status.error;
      if (body && body.error) return body.error;
      if (body && body.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch (e) {
      /* not JSON */
    }
    return (text || '').slice(0, 300);
  }

  async function once(url, { method, headers, body, timeoutMs }) {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts);
  }

  // request(url, {method, body, headers, timeoutMs, retries}) -> parsed JSON
  async function request(url, opts = {}) {
    const timeoutMs = opts.timeoutMs || 60000;
    const retries = opts.retries == null ? 1 : opts.retries;
    let lastErr = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
      let resp;
      try {
        resp = await once(url, { ...opts, timeoutMs });
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
        }
        lastErr = e;
        continue; // network-level failure: retry
      }
      if (resp.ok) {
        if (resp.status === 204) return null;
        const text = await resp.text();
        return text ? JSON.parse(text) : null;
      }
      const text = await resp.text().catch(() => '');
      if (resp.status >= 500) {
        lastErr = new Error(`${resp.status}: ${detailOf(text)}`);
        continue; // 5xx from the service: retry
      }
      // 4xx: a bad request will never succeed on retry.
      const err = new Error(`${resp.status}: ${detailOf(text)}`);
      err.status = resp.status;
      throw err;
    }
    throw lastErr || new Error(`request failed: ${url}`);
  }

  function json(url, body, opts = {}) {
    return request(url, { ...opts, method: opts.method || 'POST', body });
  }

  function join(base, path) {
    return String(base || '').replace(/\/+$/, '') + path;
  }

  globalThis.AIOSHttp = { request, json, join, sleep, detailOf };
})();
