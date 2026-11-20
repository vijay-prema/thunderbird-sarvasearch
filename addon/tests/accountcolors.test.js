'use strict';
// Account colours: Thunderbird does not expose them to extensions, so the
// resolution order (options override > bridge daemon > generated) and the
// sources' labels are the whole contract. A generated colour that claims to be
// Thunderbird's is the failure mode worth testing for.

const test = require('node:test');
const assert = require('node:assert');
const { loadLib, installSettings } = require('./harness');

loadLib('accountcolors');

const Colors = globalThis.SarvaAccountColors;

const BRIDGE = 'http://127.0.0.1:8765/accounts/colors';

function installHttp(handler) {
  const calls = [];
  globalThis.SarvaHttp = {
    async request(url, opts) {
      calls.push({ url, opts });
      return handler(url, opts);
    },
  };
  return calls;
}

function setup({ colors = {}, settings = {}, fail = false } = {}) {
  Colors.reset();
  installSettings({ bridgeUrl: 'http://127.0.0.1:8765', ...settings });
  return installHttp(() => {
    if (fail) throw new Error('bridge unreachable');
    return { ok: true, colors };
  });
}

test('a generated colour is stable per account and never off-palette', () => {
  assert.strictEqual(Colors.hashColor('account1'), Colors.hashColor('account1'));
  assert.ok(Colors.PALETTE.includes(Colors.hashColor('account1')));
  assert.ok(Colors.PALETTE.includes(Colors.hashColor('')));
  // Two accounts must not share one generated colour, or the card cannot tell
  // them apart at all — which is the only thing the generated colour is for.
  assert.notStrictEqual(Colors.hashColor('account1'), Colors.hashColor('account2'));
});

test('colours are normalised, and anything else is rejected', () => {
  assert.strictEqual(Colors.normalise('#ABC'), '#aabbcc');
  assert.strictEqual(Colors.normalise(' #26A269 '), '#26a269');
  assert.strictEqual(Colors.normalise('red'), null);
  assert.strictEqual(Colors.normalise('#12345'), null);
  assert.strictEqual(Colors.normalise(null), null);
});

test("Thunderbird's colour is used when the daemon can supply it", async () => {
  const calls = setup({ colors: { account2: '#26A269' } });
  await Colors.load({ force: true });

  const colour = Colors.colorFor('account2');
  assert.deepStrictEqual({ color: colour.color, source: colour.source }, { color: '#26a269', source: 'thunderbird' });
  assert.match(colour.label, /Thunderbird/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, BRIDGE);
});

test('a colour picked in the options page wins over Thunderbird', async () => {
  const calls = setup({
    colors: { account2: '#26a269' },
    settings: { accountColors: { account2: '#c01c28' } },
  });
  await Colors.load({ force: true });

  const colour = Colors.colorFor('account2');
  assert.strictEqual(colour.color, '#c01c28');
  assert.strictEqual(colour.source, 'settings');
  // The daemon is still asked: other accounts still want Thunderbird's colours.
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(Colors.colorFor('account3').color, Colors.hashColor('account3'));
});

test('without the daemon every account falls back to a generated colour', async () => {
  setup({ fail: true });
  await Colors.load({ force: true });

  const colour = Colors.colorFor('account2');
  assert.strictEqual(colour.color, Colors.hashColor('account2'));
  assert.strictEqual(colour.source, 'generated');
  // The tooltip has to say so: a generated colour looks exactly like a real one.
  assert.match(colour.label, /Generated/);
});

test('the token is sent, and a disabled bridge is not called at all', async () => {
  const calls = setup({ settings: { bridgeToken: 'secret' } });
  await Colors.load({ force: true });
  assert.strictEqual(calls[0].opts.headers['x-sarva-bridge-token'], 'secret');

  const none = setup({ settings: { bridgeEnabled: false } });
  await Colors.load({ force: true });
  assert.strictEqual(none.length, 0);
  assert.strictEqual(Colors.colorFor('account2').source, 'generated');
});

test('an answer is cached, and a failed refresh does not repaint the cards', async () => {
  let call = 0;
  Colors.reset();
  installSettings({ bridgeUrl: 'http://127.0.0.1:8765' });
  installHttp(() => {
    call += 1;
    if (call === 1) return { ok: true, colors: { account2: '#26a269' } };
    throw new Error('bridge restarted');
  });

  await Colors.load({ force: true });
  await Colors.load(); // inside the TTL: no second request
  assert.strictEqual(call, 1);
  assert.strictEqual(Colors.colorFor('account2').color, '#26a269');

  await Colors.load({ force: true }); // daemon gone: keep what we had
  assert.strictEqual(Colors.colorFor('account2').source, 'thunderbird');
  assert.match(Colors.snapshot().bridgeError, /restarted/);
});

test('overrides are re-read on every load, so the options page can change one', async () => {
  const settings = setup({ colors: {} });
  await Colors.load({ force: true });
  assert.strictEqual(Colors.colorFor('account2').source, 'generated');

  installSettings({ accountColors: { account2: '#1c71d8' } });
  await Colors.load();
  assert.strictEqual(Colors.colorFor('account2').source, 'settings');
  assert.strictEqual(settings.length, 1);
});
