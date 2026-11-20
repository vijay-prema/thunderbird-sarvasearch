'use strict';
// The bridge is the one piece of the add-on that talks to something outside
// Thunderbird, so its contract is pinned here: what it sends when a request
// arrives, what it acknowledges when opening fails, and that a daemon that is
// not there produces silence rather than a hot loop.

const test = require('node:test');
const assert = require('node:assert');
const { loadLib } = require('./harness');

const BASE = 'http://127.0.0.1:8765';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function install({ enabled = true, token = '', openResult = true, openThrows = null, settings = {} } = {}) {
  const calls = { fetch: [], acks: [], opened: [] };
  globalThis.SarvaSettings = {
    get: async () => ({
      bridgeEnabled: enabled,
      bridgeUrl: BASE,
      bridgeToken: token,
      ...settings,
    }),
  };
  globalThis.SarvaHttp = {
    sleep: async () => {},
    request: async (url, opts) => {
      calls.acks.push({ url, opts });
      return { ok: true };
    },
  };
  globalThis.SarvaOpen = {
    openMessage: async (msg, location) => {
      calls.opened.push({ msg, location });
      if (openThrows) throw new Error(openThrows);
      return openResult;
    },
  };
  globalThis.fetch = async (url, opts) => {
    calls.fetch.push({ url, opts });
    const next = calls.next ? calls.next.shift() : response(204);
    return next;
  };
  loadLib('bridge');
  return calls;
}

const CFG = { enabled: true, base: BASE, token: '', timeoutMs: 25000 };

test('a 204 from the daemon is idle: no open, no ack', async () => {
  const calls = install();
  calls.next = [response(204)];
  const out = await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(out.status, 'idle');
  assert.strictEqual(calls.opened.length, 0);
  assert.strictEqual(calls.acks.length, 0);
  assert.match(calls.fetch[0].url, /\/pending\?timeout=25$/);
});

test('a request is opened by RFC Message-ID and acknowledged', async () => {
  const calls = install();
  calls.next = [
    response(200, { request: { id: 'r1', account: 'account2', message_id: 'abc@example.com' } }),
    response(200, { ok: true }),
  ];
  const out = await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(out.status, 'opened');
  assert.deepStrictEqual(calls.opened[0].msg, {
    headerMessageId: 'abc@example.com',
    account_id: 'account2',
    numeric_id: null,
  });
  assert.strictEqual(calls.opened[0].location, 'tab');
  const ack = calls.acks[0];
  assert.match(ack.url, /\/ack$/);
  assert.deepStrictEqual(ack.opts.body, { id: 'r1', ok: true, error: null });
});

test('a message that cannot be found is acknowledged as a failure', async () => {
  const calls = install({ openResult: false });
  calls.next = [
    response(200, { request: { id: 'r2', account: 'account2', message_id: 'gone@example.com' } }),
    response(200, { ok: true }),
  ];
  const out = await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(out.status, 'failed');
  assert.match(out.error, /not found/);
  const ack = calls.acks[0].opts.body;
  assert.strictEqual(ack.ok, false);
  assert.match(ack.error, /not found/);
});

test('an exception while opening still produces an ack', async () => {
  const calls = install({ openThrows: 'messageDisplay.open exploded' });
  calls.next = [
    response(200, { request: { id: 'r3', message_id: 'x@example.com' } }),
    response(200, { ok: true }),
  ];
  const out = await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(calls.acks[0].opts.body.error, 'messageDisplay.open exploded');
});

test('a numeric-id-only request is passed through (mail with no Message-ID)', async () => {
  const calls = install();
  calls.next = [
    response(200, { request: { id: 'r4', numeric_id: 4242 } }),
    response(200, { ok: true }),
  ];
  await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(calls.opened[0].msg.numeric_id, 4242);
  assert.strictEqual(calls.opened[0].msg.headerMessageId, '');
});

test('a request with no usable identity is refused without touching Thunderbird', async () => {
  const calls = install();
  calls.next = [response(200, { request: { id: 'r5' } }), response(200, { ok: true })];
  const out = await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(calls.opened.length, 0);
  assert.strictEqual(calls.acks[0].opts.body.ok, false);
  assert.match(calls.acks[0].opts.body.error, /neither/);
});

test('the configured token is sent on the poll and the ack', async () => {
  const calls = install({ token: 's3cret' });
  calls.next = [
    response(200, { request: { id: 'r6', message_id: 'y@example.com' } }),
    response(200, { ok: true }),
  ];
  await globalThis.SarvaBridge.pollOnce({ ...CFG, token: 's3cret' });
  assert.strictEqual(calls.fetch[0].opts.headers['x-sarva-bridge-token'], 's3cret');
  assert.strictEqual(calls.acks[0].opts.headers['x-sarva-bridge-token'], 's3cret');
});

test('a request asking for a window is opened in a window', async () => {
  const calls = install();
  calls.next = [
    response(200, { request: { id: 'r7', message_id: 'z@example.com', location: 'window' } }),
    response(200, { ok: true }),
  ];
  await globalThis.SarvaBridge.pollOnce(CFG);
  assert.strictEqual(calls.opened[0].location, 'window');
});

test('a daemon that answers 500 surfaces as a thrown error (the loop backs off)', async () => {
  const calls = install();
  calls.next = [response(500, { error: 'boom' })];
  await assert.rejects(() => globalThis.SarvaBridge.pollOnce(CFG), /HTTP 500/);
  assert.strictEqual(calls.opened.length, 0);
});

test('settings supply the URL and the enabled flag', async () => {
  const off = install({ enabled: false });
  const cfg = await globalThis.SarvaBridge.config();
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.base, BASE);
  assert.strictEqual(off.fetch.length, 0);
});
