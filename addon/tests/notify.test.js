'use strict';
// Notification filtering: who counts as a machine sender, what the Qdrant
// filter looks like, and that the ingest path stores the flag it is built from.
//
// The flag is decided from the sender at index time (lib/notify.js), so the
// first tests are the detection rule, then the filter it feeds, then the
// ingest/backfill path that makes it queryable.

const test = require('node:test');
const assert = require('node:assert');
const { loadLib, installMessenger, fakeQdrant, fakeOllama, installSettings } = require('./harness');

loadLib('text', 'notify', 'search');

const isNotification = (from) => globalThis.SarvaNotify.isNotification(from);

test('notification senders are recognised by their address', () => {
  const yes = [
    'noreply@example.com',
    'No Reply <no-reply@example.com>',
    'Store <no.reply@example.com>',
    'system <donotreply@example.com>',
    'do-not-reply@example.com',
    'Notifications <notifications@example.com>',
    'notification-noreply@example.com',
    'tollingnotifications@example.com',
    'notify@example.com',
    'Mail Delivery System <mailer-daemon@example.com>',
    'mailer@example.com',
    'postmaster@example.com',
    'bounces+12345@example.com',
    'auto-reply@example.com',
    'auto_confirm@example.com',
    'automated@example.com',
    'Example Power Co <alerts@example.com>',
    'newsletter@example.com',
    'digest@example.com',
    'updates@example.com',
  ];
  for (const from of yes) assert.strictEqual(isNotification(from), true, `${from} should be a notification`);
});

test('people are not notifications', () => {
  const no = [
    'Priya <priya@example.com>',
    'Casey Jo <casey.jo@example.org>',
    'support@example.com',
    'Reply Team <reply@example.com>',
    'sales@example.com',
    'info@example.com',
    'news@example.com',
    'digestive@example.com',
    'updatesweekly@example.com',
    'Notifications <casey@example.com>',
    '',
    undefined,
  ];
  for (const from of no) assert.strictEqual(isNotification(from), false, `${from} should not be a notification`);
});

test('only the address is judged, never the display name', () => {
  // A person whose display name looks like a robot is still a person.
  assert.strictEqual(isNotification('Notifications Team <casey@example.com>'), false);
  // ...and a bare display name with no address is the weakest form of the test.
  assert.strictEqual(isNotification('No Reply'), true);
});

test('the filter is a boolean match, off adds nothing', () => {
  const build = globalThis.SarvaSearch.buildFilter;

  const off = build({});
  assert.strictEqual(off, undefined, 'no filter at all when nothing is set');

  const only = build({ notifications: 'only' });
  assert.deepStrictEqual(only, { must: [{ key: 'notification', match: { value: true } }] });

  // Excluding asks Qdrant to drop `true` rather than require `false`: points
  // indexed before the flag existed have no `notification` key, and must still
  // be searchable.
  const exclude = build({ notifications: 'exclude' });
  assert.deepStrictEqual(exclude, { must_not: [{ key: 'notification', match: { value: true } }] });
  assert.strictEqual(exclude.must, undefined);

  const both = build({ account: 'acct', notifications: 'exclude' });
  assert.deepStrictEqual(both.must, [{ key: 'account', match: { value: 'acct' } }]);
  assert.deepStrictEqual(both.must_not, [{ key: 'notification', match: { value: true } }]);
});

// ---- ingest side ----

function ingestSetup() {
  installMessenger();
  loadLib('index');
  const qdrant = fakeQdrant();
  const ollama = fakeOllama();
  globalThis.SarvaQdrant = qdrant;
  globalThis.SarvaOllama = ollama;
  installSettings();
  return { qdrant, ollama };
}

function doc(over = {}) {
  return {
    message_id: 'm1@example.com',
    account_id: 'acct',
    account_name: 'Work',
    subject: 'Your statement is ready',
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

test('the flag is stored with the point, from the sender', async () => {
  const { qdrant } = ingestSetup();
  const human = doc({ message_id: 'human@example.com' });
  const robot = doc({ message_id: 'robot@example.com', from: 'Example Power Co <noreply@example.com>' });
  await globalThis.SarvaIndex.ingest([human, robot]);

  const idOf = (d) => globalThis.SarvaText.pointId(d.account_id, d.message_id);
  assert.strictEqual(qdrant.points.get(await idOf(human)).payload.notification, false);
  assert.strictEqual(qdrant.points.get(await idOf(robot)).payload.notification, true);
});

test('a point indexed before the flag existed is backfilled without re-embedding', async () => {
  const { qdrant, ollama } = ingestSetup();
  const d = doc({ from: 'No Reply <noreply@example.com>' });
  await globalThis.SarvaIndex.ingest([d]);

  const id = await globalThis.SarvaText.pointId(d.account_id, d.message_id);
  delete qdrant.points.get(id).payload.notification; // the pre-feature payload

  const r = await globalThis.SarvaIndex.ingest([d]);
  assert.strictEqual(r.unchanged, 1);
  assert.strictEqual(ollama.calls.embed, 1, 'a metadata patch never re-embeds');
  assert.strictEqual(qdrant.points.get(id).payload.notification, true);
});

// ---- payload migration ----

test('the payload migration backfills the flag once, from the stored sender', async () => {
  const { qdrant } = ingestSetup();
  // Points indexed by a build that predates the flag: one robot, one person
  // (the person already carries false, as a rebuild would have left it).
  qdrant.points.set('p1', {
    payload: { account: 'acct', message_id: 'a@example.com', from: 'No Reply <noreply@example.com>' },
  });
  qdrant.points.set('p2', {
    payload: { account: 'acct', message_id: 'b@example.com', from: 'Casey <casey@example.com>', notification: false },
  });

  const first = await globalThis.SarvaIndex.runMigrations();
  assert.strictEqual(first['notification-flag'].scanned, 2);
  assert.strictEqual(first['notification-flag'].updated, 1, 'only the point missing the flag is written');
  assert.strictEqual(qdrant.points.get('p1').payload.notification, true);
  assert.strictEqual(qdrant.points.get('p2').payload.notification, false);
  assert.strictEqual(qdrant.calls.upsert, 0, 'a payload migration never rewrites a point');

  const second = await globalThis.SarvaIndex.runMigrations();
  assert.strictEqual(second, null, 'the run is recorded, so it happens once');

  await globalThis.SarvaIndex.clear();
  assert.ok(await globalThis.SarvaIndex.runMigrations(), 'Clear forgets the record along with the index');
});

// ---- search side ----

function searchSetup() {
  installMessenger();
  loadLib('search');
  const qdrant = fakeQdrant();
  qdrant.query = async (body) => {
    qdrant.calls.query.push(body);
    const hits = body.using === 'subject' ? [{ id: 'x', score: 1, payload: { account: 'acct', message_id: 'a' } }] : [];
    return { result: { points: hits } };
  };
  globalThis.SarvaQdrant = qdrant;
  globalThis.SarvaOllama = fakeOllama();
  globalThis.SarvaIndex = { ensureReady: async () => {} };
  installSettings();
  return { qdrant };
}

test('search passes the mode through to every query and echoes it back', async () => {
  const { qdrant } = searchSetup();

  const hidden = await globalThis.SarvaSearch.search({ query: 'x', mode: 'keyword', limit: 5, notifications: 'exclude' });
  assert.strictEqual(hidden.notifications, 'exclude');
  assert.ok(qdrant.calls.query.length, 'the keyword engines were queried');
  for (const body of qdrant.calls.query) {
    assert.deepStrictEqual(body.filter.must_not, [{ key: 'notification', match: { value: true } }]);
  }

  const only = await globalThis.SarvaSearch.search({ query: 'x', mode: 'keyword', limit: 5, notifications: 'only' });
  assert.strictEqual(only.notifications, 'only');
  assert.deepStrictEqual(qdrant.calls.query.at(-1).filter.must, [{ key: 'notification', match: { value: true } }]);

  const off = await globalThis.SarvaSearch.search({ query: 'x', mode: 'keyword', limit: 5 });
  assert.strictEqual(off.notifications, 'off');
  assert.strictEqual(qdrant.calls.query.at(-1).filter, undefined, 'off filters nothing');

  const bogus = await globalThis.SarvaSearch.search({ query: 'x', mode: 'keyword', limit: 5, notifications: 'nope' });
  assert.strictEqual(bogus.notifications, 'off', 'an unknown mode is not a filter');
});
