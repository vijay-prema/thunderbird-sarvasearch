'use strict';
// Ingest, folder-merge, attachment-backfill, reconcile and clear semantics.
// Losing one of these rules silently corrupts the index (a re-embedded mailbox,
// or attachment names wiped by a header-only re-read), so each has a test.

const test = require('node:test');
const assert = require('node:assert');
const { loadLib, installMessenger, fakeQdrant, fakeOllama, installSettings } = require('./harness');

loadLib('text');

function setup({ qdrantOpts = {}, ollamaOpts = {} } = {}) {
  installMessenger();
  loadLib('index');
  const qdrant = fakeQdrant(qdrantOpts);
  const ollama = fakeOllama(ollamaOpts);
  globalThis.AIOSQdrant = qdrant;
  globalThis.AIOSOllama = ollama;
  installSettings();
  return { qdrant, ollama };
}

function doc(over = {}) {
  return {
    message_id: 'm1@example.com',
    account_id: 'acct',
    account_name: 'Work',
    subject: 'Invoice #1',
    from: 'Priya <priya@example.com>',
    to: 'Me <me@example.com>',
    date: '2026-01-01T00:00:00.000Z',
    date_ms: 1767225600000,
    folder: 'Inbox',
    body: 'hello world',
    snippet: 'hello world',
    numeric_id: 5,
    header_only: false,
    encrypted: false,
    attachments: [],
    ...over,
  };
}

async function idOf(d) {
  return globalThis.AIOSText.pointId(d.account_id, d.message_id);
}

test('a new message is embedded and stored with its hash and folder', async () => {
  const { qdrant, ollama } = setup();
  const d = doc();
  const r = await globalThis.AIOSIndex.ingest([d]);

  assert.strictEqual(r.indexed, 1);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(ollama.calls.embed, 1);
  const stored = qdrant.points.get(await idOf(d));
  assert.ok(stored, 'point stored');
  assert.strictEqual(stored.payload.folders[0], 'Inbox');
  assert.match(stored.payload.content_hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(stored.payload.attachments, []);
});

test('unchanged content is not re-embedded', async () => {
  const { ollama } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  const r = await globalThis.AIOSIndex.ingest([d]);

  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual(ollama.calls.embed, 1, 'no second embedding call');
});

test('the same message in a second folder merges its folder list', async () => {
  const { qdrant, ollama } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  const r = await globalThis.AIOSIndex.ingest([doc({ folder: 'Sent' })]);

  assert.strictEqual(r.folders_added, 1);
  assert.strictEqual(ollama.calls.embed, 1, 'folders are metadata, not content');
  assert.deepStrictEqual(qdrant.points.get(await idOf(d)).payload.folders, ['Inbox', 'Sent']);
});

test('edited content re-embeds and keeps the folder union', async () => {
  const { qdrant, ollama } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  await globalThis.AIOSIndex.ingest([doc({ folder: 'Sent' })]);
  const r = await globalThis.AIOSIndex.ingest([doc({ folder: 'Archive', body: 'edited body' })]);

  assert.strictEqual(r.updated, 1);
  assert.strictEqual(ollama.calls.embed, 2);
  const stored = qdrant.points.get(await idOf(d));
  assert.deepStrictEqual(stored.payload.folders, ['Archive', 'Inbox', 'Sent']);
  assert.strictEqual(stored.payload.body, 'edited body');
});

test('attachment names backfill without re-embedding', async () => {
  const { qdrant, ollama } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  await globalThis.AIOSIndex.ingest([doc({ attachments: ['invoice.pdf'] })]);

  assert.strictEqual(ollama.calls.embed, 1, 'attachments are not part of the embed text');
  assert.deepStrictEqual(qdrant.points.get(await idOf(d)).payload.attachments, ['invoice.pdf']);
});

test('an empty attachment list from a header-only read never erases stored names', async () => {
  const { qdrant } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  await globalThis.AIOSIndex.ingest([doc({ attachments: ['invoice.pdf'] })]);
  await globalThis.AIOSIndex.ingest([doc({ attachments: [], header_only: true })]);

  assert.deepStrictEqual(
    qdrant.points.get(await idOf(d)).payload.attachments,
    ['invoice.pdf'],
    'header-only read cannot see the MIME parts, so it must not clear them'
  );
});

test('an authoritative empty attachment list clears wrong names', async () => {
  const { qdrant } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  await globalThis.AIOSIndex.ingest([doc({ attachments: ['wrong.eml'] })]);
  // A full read that definitively sees no attachments must clear a wrong value.
  await globalThis.AIOSIndex.ingest([doc({ attachments: [], header_only: false })]);

  assert.deepStrictEqual(qdrant.points.get(await idOf(d)).payload.attachments, []);
});

test('a message Ollama refuses is counted, skipped, and not retried forever', async () => {
  const { qdrant, ollama } = setup({
    ollamaOpts: { failFor: (t) => t.includes('poison') },
  });
  const bad = doc({ message_id: 'bad@example.com', body: 'poison' });
  const r1 = await globalThis.AIOSIndex.ingest([bad]);
  assert.strictEqual(r1.embed_failed, 1);
  assert.strictEqual(qdrant.points.size, 0);

  const before = ollama.calls.embed;
  const r2 = await globalThis.AIOSIndex.ingest([bad]);
  assert.strictEqual(r2.embed_failed, 1);
  assert.strictEqual(ollama.calls.embed, before, 'recorded failure is not re-sent');
});

test('one rejected payload does not lose the rest of its batch', async () => {
  const { qdrant } = setup({
    qdrantOpts: {
      failUpsertWhen: (p) => p.payload.subject === 'POISON',
    },
  });
  const good = doc({ message_id: 'good@example.com' });
  const bad = doc({ message_id: 'bad@example.com', subject: 'POISON' });
  const r = await globalThis.AIOSIndex.ingest([good, bad]);

  assert.strictEqual(r.failed, 1);
  assert.strictEqual(qdrant.points.size, 1, 'the good message is still indexed');
  assert.ok(qdrant.points.get(await idOf(good)));
});

test('removing a folder deletes the point only when the last folder goes', async () => {
  const { qdrant } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);
  await globalThis.AIOSIndex.ingest([doc({ folder: 'Sent' })]);

  let r = await globalThis.AIOSIndex.removeFolder([{ account_id: 'acct', message_id: d.message_id, folder: 'Inbox' }]);
  assert.strictEqual(r.updated, 1);
  assert.deepStrictEqual(qdrant.points.get(await idOf(d)).payload.folders, ['Sent']);

  r = await globalThis.AIOSIndex.removeFolder([{ account_id: 'acct', message_id: d.message_id, folder: 'Sent' }]);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(qdrant.points.size, 0);
});

test('reconcile deletes orphans, fixes folders, and reports what is missing', async () => {
  const { qdrant } = setup();
  const a = doc({ message_id: 'a@example.com' });
  const orphan = doc({ message_id: 'orphan@example.com' });
  await globalThis.AIOSIndex.ingest([a, orphan]);

  const r = await globalThis.AIOSIndex.reconcile([
    { account_id: 'acct', message_id: 'a@example.com', folders: ['Inbox', 'Sent'] },
    { account_id: 'acct', message_id: 'missing@example.com', folders: ['Inbox'] },
  ]);

  assert.strictEqual(r.deleted, 1, 'orphan removed');
  assert.strictEqual(r.folders_updated, 1, 'folder drift fixed');
  assert.deepStrictEqual(r.missing, [{ account_id: 'acct', message_id: 'missing@example.com' }]);
  assert.deepStrictEqual(qdrant.points.get(await idOf(a)).payload.folders, ['Inbox', 'Sent']);
});

test('known() reports which messages are indexed', async () => {
  const { } = setup();
  const d = doc();
  await globalThis.AIOSIndex.ingest([d]);

  const known = await globalThis.AIOSIndex.known([
    { account_id: 'acct', message_id: d.message_id },
    { account_id: 'acct', message_id: 'nope@example.com' },
  ]);
  assert.deepStrictEqual(known, [{ account_id: 'acct', message_id: d.message_id }]);
});

test('clear drops the collection and forgets embed failures', async () => {
  const { qdrant } = setup();
  await globalThis.AIOSIndex.ingest([doc()]);
  await globalThis.AIOSIndex.clear();
  assert.strictEqual(qdrant.calls.drop, 1);
  assert.strictEqual(qdrant.points.size, 0);
  assert.strictEqual(await globalThis.AIOSIndex.stats().then((s) => s.total_emails), 0);
});
