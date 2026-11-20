'use strict';
// Opening one attachment. The card only knows attachment NAMES (that is what the
// payload stores), so the click has to match a name against the live
// listAttachments() list and hand Thunderbird the MIME part name — the failure
// modes worth pinning are "two attachments called scan.pdf" and "the message or
// attachment is gone since it was indexed".

const test = require('node:test');
const assert = require('node:assert');
const { loadLib } = require('./harness');

loadLib('attach');
const Attach = globalThis.SarvaAttach;

const LIST = [
  { name: 'invoice.pdf', partName: '1.2' },
  { name: 'scan.pdf', partName: '1.3' },
  { name: 'scan.pdf', partName: '1.4' },
];

function installMessenger({ list = LIST, opens = [], failList = false, failOpen = false, tab = { id: 7 } } = {}) {
  globalThis.messenger = {
    tabs: {
      getCurrent: async () => {
        if (tab === 'throw') throw new Error('not in a tab');
        return tab;
      },
    },
    mailTabs: { query: async () => [{ id: 99 }] },
    messages: {
      async listAttachments() {
        if (failList) throw new Error('message not readable');
        return list;
      },
      async openAttachment(id, partName, tabId) {
        if (failOpen) throw new Error('no handler');
        opens.push({ id, partName, tabId });
      },
    },
  };
  return opens;
}

test('the stored position picks between two attachments with the same name', () => {
  assert.strictEqual(Attach.pick(LIST, 'scan.pdf', 1).partName, '1.3');
  assert.strictEqual(Attach.pick(LIST, 'scan.pdf', 2).partName, '1.4');
  assert.strictEqual(Attach.pick(LIST, 'invoice.pdf', 0).partName, '1.2');
});

test('a shifted list falls back to the name, a vanished one resolves to nothing', () => {
  // An attachment was removed since the message was indexed: position 1 is now
  // "scan.pdf", but the card said "invoice.pdf" was there.
  const shifted = [LIST[1], LIST[2]];
  assert.strictEqual(Attach.pick(shifted, 'invoice.pdf', 0), null);
  assert.strictEqual(Attach.pick(shifted, 'scan.pdf', 0).partName, '1.3');
  // Name matching ignores case and surrounding space (the payload is a display
  // name, not a byte-exact key).
  assert.strictEqual(Attach.pick(LIST, ' Invoice.PDF ', 0).partName, '1.2');
  assert.deepStrictEqual(Attach.pick([], 'invoice.pdf', 0), null);
  assert.deepStrictEqual(Attach.pick(null, 'invoice.pdf', 0), null);
});

test('opening sends the resolved id, the part name and a tab', async () => {
  const opens = installMessenger();
  globalThis.SarvaOpen = { resolveMessageId: async () => 42 };

  const outcome = await Attach.open({ headerMessageId: 'x@example.com' }, { name: 'scan.pdf', index: 2 });
  assert.deepStrictEqual(outcome, { ok: true, name: 'scan.pdf' });
  assert.deepStrictEqual(opens, [{ id: 42, partName: '1.4', tabId: 7 }]);
});

test('a message that can no longer be resolved opens nothing', async () => {
  const opens = installMessenger();
  globalThis.SarvaOpen = { resolveMessageId: async () => null };
  const outcome = await Attach.open({ headerMessageId: 'gone@example.com' }, { name: 'scan.pdf', index: 0 });
  assert.strictEqual(outcome.reason, 'message-not-found');
  assert.strictEqual(opens.length, 0);
});

test('an unreadable attachment list and a failed open are reported, not thrown', async () => {
  globalThis.SarvaOpen = { resolveMessageId: async () => 42 };

  installMessenger({ failList: true });
  assert.deepStrictEqual(
    await Attach.open({ headerMessageId: 'x@example.com' }, { name: 'scan.pdf', index: 0 }),
    { ok: false, reason: 'list-failed', error: 'message not readable' }
  );

  installMessenger({ failOpen: true });
  const outcome = await Attach.open({ headerMessageId: 'x@example.com' }, { name: 'scan.pdf', index: 0 });
  assert.strictEqual(outcome.reason, 'open-failed');
  assert.match(outcome.error, /no handler/);
});

test('a mail tab is borrowed when the click does not come from a tab', async () => {
  const opens = installMessenger({ tab: 'throw' });
  globalThis.SarvaOpen = { resolveMessageId: async () => 42 };
  await Attach.open({ headerMessageId: 'x@example.com' }, { name: 'invoice.pdf', index: 0 });
  assert.strictEqual(opens[0].tabId, 99);
});
