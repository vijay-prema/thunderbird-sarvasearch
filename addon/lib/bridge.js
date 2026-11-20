'use strict';
// Opening a message on request from outside Thunderbird. Exposes
// globalThis.SarvaBridge.
//
// A WebExtension cannot listen on a TCP port, so the direction is inverted: a
// small localhost daemon (tools/bridge.js) owns the queue and the add-on
// long-polls it. One GET hangs for ~25 s, so a click opens the message in well
// under a second with no polling traffic in between — and a daemon that is not
// running costs one refused connection and a quiet backoff, not a busy loop.
//
// A request carries the RFC Message-ID, never Thunderbird's numeric id: only
// SarvaOpen can resolve that to the id this session is using, and it already
// does the re-resolution (a reissued id can silently address another message).
// A numeric id is accepted only as a fallback for mail that has no Message-ID.
//
// Protocol (one round trip per open, plus the long poll):
//   GET  {base}/pending?timeout=25 -> 200 {request:{id,account,message_id,location}} | 204
//   POST {base}/ack        {id, ok, error?}
(function () {
  const POLL_SECONDS = 25;
  const OFFLINE_DELAY_MS = 5000; // first retry after a refused connection
  // A re-spawned daemon must be picked up promptly: the CLI starts one on
  // demand, and a 60 s ceiling would make the first click after that look broken.
  const OFFLINE_MAX_MS = 15000;
  const DISABLED_DELAY_MS = 30000; // re-check only, no traffic

  const state = {
    running: false,
    offline: false,
    base: '',
    opened: 0,
    failed: 0,
    lastOpenedAt: null,
    lastPollAt: null,
    lastError: null,
  };

  let loopToken = 0;

  async function config() {
    const s = await SarvaSettings.get();
    return {
      enabled: s.bridgeEnabled !== false,
      base: String(s.bridgeUrl || 'http://127.0.0.1:8765').replace(/\/+$/, ''),
      token: s.bridgeToken || '',
      timeoutMs: POLL_SECONDS * 1000,
    };
  }

  function headersFor(cfg, json) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (cfg.token) headers['x-sarva-bridge-token'] = cfg.token;
    return headers;
  }

  // Report the outcome so the daemon (and whoever clicked) learns whether the
  // message actually opened. A failed ack is not an error here — the queue item
  // is consumed either way, and retrying a deleted message helps nobody.
  async function ack(cfg, id, outcome) {
    try {
      await SarvaHttp.request(`${cfg.base}/ack`, {
        method: 'POST',
        headers: headersFor(cfg, true),
        body: { id, ok: !!outcome.ok, error: outcome.error || null },
        timeoutMs: 8000,
        retries: 0,
      });
    } catch (e) {
      console.warn('[SarvaSearch] bridge: could not acknowledge %s: %s', id, e.message);
    }
  }

  async function handleRequest(req) {
    const msg = {
      headerMessageId: req.message_id || '',
      account_id: req.account || '',
      numeric_id: req.numeric_id == null ? null : req.numeric_id,
    };
    if (!msg.headerMessageId && msg.numeric_id == null) {
      state.failed += 1;
      return { ok: false, error: 'request carried neither message_id nor numeric_id' };
    }
    try {
      const ok = await SarvaOpen.openMessage(msg, req.location === 'window' ? 'window' : 'tab');
      if (ok) {
        state.opened += 1;
        state.lastOpenedAt = Date.now();
        state.lastError = null;
        return { ok: true };
      }
      state.failed += 1;
      state.lastError = 'message not found in Thunderbird';
      return { ok: false, error: 'message not found: moved, deleted, or still unsynchronised' };
    } catch (e) {
      state.failed += 1;
      state.lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  // One poll iteration, start to finish. No timers, no loop: the caller decides
  // when to call it again, which is what makes the behaviour testable.
  async function pollOnce(cfg) {
    const url = `${cfg.base}/pending?timeout=${Math.round(cfg.timeoutMs / 1000)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: headersFor(cfg),
      signal: AbortSignal.timeout(cfg.timeoutMs + 10000),
    });
    state.lastPollAt = Date.now();
    state.base = cfg.base;
    if (res.status === 204) return { status: 'idle' };
    if (!res.ok) throw new Error(`bridge answered HTTP ${res.status}`);
    const body = await res.json();
    const req = body && body.request;
    if (!req || !req.id) return { status: 'idle' };
    const outcome = await handleRequest(req);
    await ack(cfg, req.id, outcome);
    return { status: outcome.ok ? 'opened' : 'failed', request: req, error: outcome.error };
  }

  async function loop(token) {
    let backoff = OFFLINE_DELAY_MS;
    while (token === loopToken) {
      let cfg;
      try {
        cfg = await config();
      } catch (e) {
        cfg = { enabled: false };
      }
      if (!cfg.enabled) {
        await SarvaHttp.sleep(DISABLED_DELAY_MS);
        continue;
      }
      try {
        await pollOnce(cfg);
        backoff = OFFLINE_DELAY_MS;
        if (state.offline) {
          state.offline = false;
          console.info('[SarvaSearch] bridge connected at %s', cfg.base);
        }
      } catch (e) {
        const msg = (e && e.message) || String(e);
        state.lastError = msg;
        // A missing daemon is the normal case for anyone not using the bridge:
        // say it once, then stay quiet.
        if (!state.offline) {
          state.offline = true;
          console.info(
            '[SarvaSearch] bridge daemon not reachable at %s (%s) — retrying quietly',
            cfg.base,
            msg
          );
        }
        await SarvaHttp.sleep(backoff);
        backoff = Math.min(backoff * 2, OFFLINE_MAX_MS);
      }
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    loopToken += 1;
    loop(loopToken).catch((e) => console.error('[SarvaSearch] bridge loop stopped:', e));
  }

  function stop() {
    state.running = false;
    loopToken += 1;
  }

  function status() {
    return {
      enabled: state.running,
      connected: !state.offline && state.lastPollAt != null,
      url: state.base,
      opened: state.opened,
      failed: state.failed,
      lastOpenedAt: state.lastOpenedAt,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
    };
  }

  // Settings changed (URL, token, on/off): drop the current long poll so the
  // next iteration reads the new values instead of waiting out the old one.
  function restart() {
    stop();
    start();
  }

  globalThis.SarvaBridge = { start, stop, restart, status, pollOnce, config, handleRequest };
})();
