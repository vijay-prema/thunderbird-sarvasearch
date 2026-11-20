'use strict';
// The CLI/agent surface must agree with the add-on at the two points where a
// silent disagreement would be expensive:
//
//   1. the point id — if tools/lib/runtime.js derived it differently, every
//      "open this hit" link would address a message that does not exist;
//   2. the settings defaults — the CLI must not invent a collection name or
//      ranking weights the add-on is not using.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const { loadRuntime } = require(path.join(REPO, 'tools', 'lib', 'runtime.js'));
const sarva = require(path.join(REPO, 'tools', 'sarva.js'));

// Independent uuid5 (RFC 4122 §4.3) over the URL namespace, so parity is
// checked against the spec rather than against the implementation.
function uuid5(name) {
  const ns = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('runtime exposes the add-on modules the CLI drives', () => {
  const rt = loadRuntime();
  for (const name of ['SarvaHttp', 'SarvaSettings', 'SarvaText', 'SarvaQdrant', 'SarvaOllama', 'SarvaSearch']) {
    assert.ok(rt[name], `${name} missing`);
  }
  assert.strictEqual(typeof rt.SarvaSearch.search, 'function');
  assert.strictEqual(typeof rt.SarvaSearch.fuse, 'function');
  assert.strictEqual(typeof rt.SarvaQdrant.query, 'function');
});

test('point ids match the add-on derivation and a fixed fixture', async () => {
  const rt = loadRuntime();
  const account = 'account2';
  const messageId = '9F2C41A7-0B3D-4E58-9A61-7C5E2D8B1F44@example.com';
  const fromRuntime = await rt.SarvaText.pointId(account, messageId);
  assert.strictEqual(fromRuntime, uuid5(`${account}|${messageId}`));
  // Pinned: a drift in the derivation would break every stored "open this hit" link.
  assert.strictEqual(fromRuntime, '909817ff-4c4d-5153-94a8-1cee37f9d998');
});

test('settings come from the add-on defaults, not CLI guesses', async () => {
  const rt = loadRuntime();
  const s = await rt.SarvaSettings.get();
  assert.strictEqual(s.collection, 'sarvasearch');
  assert.strictEqual(s.qdrantUrl, 'http://127.0.0.1:6333');
  assert.strictEqual(s.ollamaModel, 'nomic-embed-text');
  assert.deepStrictEqual(s.keywordWeights, { subject: 8, from: 4, to: 2, body: 1 });
  assert.strictEqual(s.rrfK, 60);
  assert.strictEqual(s.bridgeEnabled, true);
  assert.strictEqual(s.bridgeUrl, 'http://127.0.0.1:8765');
});

test('overrides win over the config file, and flag parsing keeps values with flags', async () => {
  const rt = loadRuntime({ collection: 'other', bridgeUrl: 'http://127.0.0.1:9000/' });
  const s = await rt.SarvaSettings.get();
  assert.strictEqual(s.collection, 'other');

  const args = sarva.parseArgs(['search', 'rates', 'notice', '--limit', '5', '--json', '--from', 'council']);
  assert.deepStrictEqual(args._, ['search', 'rates', 'notice']);
  assert.strictEqual(args.flags.limit, '5');
  assert.strictEqual(args.flags.json, true);
  assert.strictEqual(args.flags.from, 'council');
});

test('the clickable link carries account and message id, URL-encoded', () => {
  const rt = { rawConfig: { bridgeUrl: 'http://127.0.0.1:8765' } };
  const url = sarva.openUrl(rt, { account: 'account2', message_id: 'a+b@mail.example.com' });
  assert.strictEqual(
    url,
    'http://127.0.0.1:8765/open?account=account2&message_id=a%2Bb%40mail.example.com'
  );
  assert.match(sarva.openUrl(rt, { account: 'a', message_id: 'm' }, 'window'), /location=window/);
});

test('the bridge daemon is started only when nothing answers, and only once', async () => {
  const rt = loadRuntime({ bridgeUrl: 'http://127.0.0.1:8765' });
  const launched = [];
  const noSleep = async () => {};
  const launch = (base, token) => {
    launched.push({ base, token });
    return 12345;
  };

  // Already running: never launch a second copy.
  const up = await sarva.ensureDaemon(rt, {
    launch,
    sleep: noSleep,
    probe: async () => ({ ok: true, waiting_clients: 1 }),
  });
  assert.strictEqual(up.running, true);
  assert.strictEqual(up.started, false);
  assert.strictEqual(up.clients, 1);
  assert.strictEqual(launched.length, 0);

  // Nothing listening: launch once, then report the fresh health.
  let calls = 0;
  const down = await sarva.ensureDaemon(rt, {
    launch,
    sleep: noSleep,
    probe: async () => (calls++ === 0 ? null : { ok: true, waiting_clients: 0 }),
  });
  assert.strictEqual(down.started, true);
  assert.strictEqual(down.running, true);
  assert.strictEqual(down.pid, 12345);
  assert.strictEqual(launched.length, 1);
  assert.strictEqual(launched[0].base, 'http://127.0.0.1:8765');

  // --no-daemon stays passive.
  const off = await sarva.ensureDaemon(rt, { allow: false, launch, sleep: noSleep, probe: async () => null });
  assert.strictEqual(off.running, false);
  assert.strictEqual(off.started, false);
  assert.strictEqual(launched.length, 1);

  // A daemon that never comes up is reported, not assumed.
  const dead = await sarva.ensureDaemon(rt, { launch, sleep: noSleep, probe: async () => null });
  assert.strictEqual(dead.running, false);
  assert.strictEqual(dead.started, true);
  assert.match(dead.error, /did not answer/);
});

test('the daemon URL is normalised from settings, not hard-coded', () => {
  assert.strictEqual(sarva.bridgeBase({ rawConfig: { bridgeUrl: 'http://127.0.0.1:9000/' } }), 'http://127.0.0.1:9000');
  assert.strictEqual(sarva.bridgeBase({ rawConfig: {} }), 'http://127.0.0.1:8765');
});
