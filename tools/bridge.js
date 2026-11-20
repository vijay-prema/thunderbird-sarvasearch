#!/usr/bin/env node
'use strict';
// SarvaSearch bridge daemon. The other half of addon/lib/bridge.js.
//
// The Thunderbird addon cannot listen on a socket, so this process holds the
// queue of "open this message" requests and the addon long-polls it. It is also
// what makes a search result clickable: a link in the chat/terminal points at
// GET /open, and this daemon turns that click into a request the addon picks up
// within a second.
//
// Endpoints (all on 127.0.0.1 unless --host says otherwise):
//   GET  /pending?timeout=25   addon long poll -> 200 {request} | 204
//   POST /ack                  addon reports {id, ok, error}
//   GET  /open?account=&message_id=[&location=&format=json&wait=10]
//                              enqueue (this is the clickable link)
//   POST /open                 same, JSON body
//   GET  /health               queue depth, connected clients, last ack
//   GET  /                     tiny status page
//
// No dependencies: node:http only. Requests live in memory, so a restart drops
// any un-clicked link — clicking again is the retry.
//
//   node tools/bridge.js serve --port 8765
//   node tools/bridge.js serve --token <secret>     (must match the addon setting)

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
const MAX_QUEUE = 50;
const PENDING_MAX_S = 25;
const ACK_WAIT_MS = 10000;

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function createServer({ token = '', log = () => {} } = {}) {
  /** @type {Array<object>} */
  const queue = [];
  /** @type {Map<string, {ok: boolean, error: string|null, at: number}>} */
  const acks = new Map();
  /** @type {Set<{res: import('node:http').ServerResponse, timer: NodeJS.Timeout}>} */
  const waiters = new Set();
  const stats = { enqueued: 0, delivered: 0, acked: 0, failed: 0, startedAt: Date.now(), lastAckAt: null };

  function authorised(req) {
    if (!token) return true;
    return req.headers['x-sarva-bridge-token'] === token;
  }

  function takeWaiter() {
    for (const w of waiters) {
      waiters.delete(w);
      clearTimeout(w.timer);
      return w.res;
    }
    return null;
  }

  function deliver(res, request) {
    const body = JSON.stringify({ request });
    stats.delivered += 1;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function flush() {
    while (queue.length) {
      const next = takeWaiter();
      if (!next) return;
      deliver(next, queue.shift());
    }
  }

  function enqueue(request) {
    if (queue.length >= MAX_QUEUE) queue.shift(); // a stale click must not block new ones
    queue.push(request);
    stats.enqueued += 1;
    log(`queued ${request.id} ${request.account || '-'} ${request.message_id || '-'}`);
    flush();
  }

  function waitForAck(id, ms) {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const tick = () => {
        const hit = acks.get(id);
        if (hit) {
          acks.delete(id);
          return resolve(hit);
        }
        if (Date.now() >= deadline) return resolve({ ok: false, error: 'timed out waiting for Thunderbird', timeout: true });
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  function json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  const page = (title, message, detail) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #101014; color: #e8e8ef }
  main { max-width: 34rem; padding: 2rem 2.5rem; border: 1px solid #2a2a33;
         border-radius: 14px; background: #17171d }
  h1 { font-size: 1.1rem; margin: 0 0 .6rem; font-weight: 600 }
  p { margin: 0; color: #a9a9b8 }
  code { color: #c9c9d6; font-size: .85rem; word-break: break-all }
</style></head>
<body><main><h1>${title}</h1><p>${message}</p>${detail ? `<p style="margin-top:.8rem"><code>${detail}</code></p>` : ''}</main></body></html>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Unauthenticated on purpose: counters and queue depth, never mail.
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        uptime_ms: Date.now() - stats.startedAt,
        queued: queue.length,
        waiting_clients: waiters.size,
        stats,
      });
    }

    if (!authorised(req)) return json(res, 401, { ok: false, error: 'bad or missing x-sarva-bridge-token' });

    // ---- addon side ----
    if (url.pathname === '/pending' && req.method === 'GET') {
      const secs = Math.max(1, Math.min(PENDING_MAX_S, Number(url.searchParams.get('timeout')) || PENDING_MAX_S));
      if (queue.length) return deliver(res, queue.shift());
      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      }, secs * 1000);
      waiters.add(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
      });
      return undefined;
    }

    if (url.pathname === '/ack' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.id) return json(res, 400, { ok: false, error: 'need {id, ok, error}' });
      acks.set(body.id, { ok: !!body.ok, error: body.error || null, at: Date.now() });
      stats.acked += body.ok ? 1 : 0;
      if (!body.ok) stats.failed += 1;
      stats.lastAckAt = Date.now();
      log(`ack ${body.id} ok=${!!body.ok}${body.error ? ` error=${body.error}` : ''}`);
      return json(res, 200, { ok: true });
    }

    // ---- clickable side ----
    if (url.pathname === '/open') {
      // Query string and JSON body are merged: `?format=json` on a POST must
      // behave the same as `"format":"json"` in the body, or a client that puts
      // the format in the URL gets an HTML page it cannot parse.
      const query = Object.fromEntries(url.searchParams);
      let payload;
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return json(res, 400, { ok: false, error: 'invalid JSON body' });
        payload = { ...query, ...body };
      } else {
        payload = query;
      }
      const messageId = payload.message_id || payload.messageId || payload.id || '';
      const account = payload.account || payload.account_id || '';
      if (!messageId && !payload.numeric_id) {
        return json(res, 400, { ok: false, error: 'need message_id (or numeric_id)' });
      }
      const request = {
        id: newId(),
        account,
        message_id: messageId,
        numeric_id: payload.numeric_id == null || payload.numeric_id === '' ? null : Number(payload.numeric_id),
        location: payload.location === 'window' ? 'window' : 'tab',
        created_at: Date.now(),
      };
      enqueue(request);
      const waitMs = Math.max(0, Math.min(30000, Number(payload.wait == null ? ACK_WAIT_MS / 1000 : payload.wait) * 1000));
      const outcome = waitMs ? await waitForAck(request.id, waitMs) : { ok: true, pending: true };

      if (payload.format === 'json' || req.headers.accept === 'application/json') {
        return json(res, 200, { ...outcome, request: { account, message_id: messageId } });
      }
      if (outcome.ok) {
        return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          page('Opening in Thunderbird', 'The message should be opening in a new tab.', messageId)
        );
      }
      return res.writeHead(outcome.timeout ? 504 : 502, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          outcome.timeout ? 'Thunderbird did not answer' : 'Could not open the message',
          outcome.timeout
            ? 'Is Thunderbird running, with SarvaSearch installed and the bridge enabled?'
            : String(outcome.error || 'unknown error'),
          messageId
        )
      );
    }

    if (url.pathname === '/') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          'SarvaSearch bridge',
          queue.length || waiters.size
            ? `${queue.length} queued, ${waiters.size} Thunderbird client(s) attached.`
            : 'Idle. Waiting for Thunderbird to attach.',
          `/health has the details · ${stats.enqueued} requests served`
        )
      );
    }

    return json(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
  });

  server.on('clientError', (_err, socket) => socket.destroy());
  return { server, stats, queue, acks, waiters };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'serve';
  if (cmd !== 'serve') {
    console.error(`usage: node tools/bridge.js [serve] [--port ${DEFAULT_PORT}] [--host ${DEFAULT_HOST}] [--token SECRET] [--quiet]`);
    process.exit(2);
  }
  const port = Number(args.port || process.env.SARVA_BRIDGE_PORT || DEFAULT_PORT);
  const host = args.host || DEFAULT_HOST;
  const token = args.token || process.env.SARVA_BRIDGE_TOKEN || '';
  const log = args.quiet ? () => {} : (line) => console.log(`[bridge] ${line}`);
  const { server } = createServer({ token, log });
  server.listen(port, host, () => {
    console.log(`[bridge] listening on http://${host}:${port}${token ? ' (token required)' : ''}`);
    console.log('[bridge] clickable links: http://%s:%d/open?account=<account>&message_id=<message-id>', host, port);
  });
  const bye = () => server.close(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return server;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { createServer, parseArgs, main };
