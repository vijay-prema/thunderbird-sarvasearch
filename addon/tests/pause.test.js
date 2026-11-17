'use strict';
// Pause is cooperative, so the property that matters is not "does the button
// say paused" but "does the loop actually stop, and does resuming lose or
// duplicate anything". These tests drive the REAL reader/events loops over a
// fake mailbox: a pause must park the job between messages (no body read in
// flight while held, nothing half-written), and resuming must index every
// message exactly once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadLib,
  loadIngest,
  fakeStorage,
  fakeQdrant,
  fakeOllama,
  installSettings,
} = require('./harness');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A paused job is expected to stop moving; anything still moving is an
// in-flight message finishing, so wait until two consecutive samples agree.
// `min` makes the sample prove work actually started first: a job that has not
// reached its first message yet also "stops", and a test that settles on that
// would pass without the gate ever blocking anything.
async function settle(sample, { min = 0, tries = 200, gapMs = 20 } = {}) {
  let last = -1;
  for (let i = 0; i < tries; i += 1) {
    await sleep(gapMs);
    const now = sample();
    if (now > min && now === last) return now;
    last = now;
  }
  throw new Error(`progress never settled above ${min} while paused — the job is not blocking`);
}

// ---- fake Thunderbird mailbox ----

function fakeMailbox({ folderNames = ['Inbox'], perFolder = 10, pageSize = 25 } = {}) {
  let nextId = 1;
  const byFolder = new Map();
  const byId = new Map();

  const folders = folderNames.map((name) => ({
    id: `acct/${name}`,
    name,
    accountId: 'acct',
    type: name === 'Inbox' ? 'inbox' : 'folder',
    subFolders: [],
  }));

  for (const folder of folders) {
    const messages = [];
    for (let i = 0; i < perFolder; i += 1) {
      const id = nextId++;
      const header = {
        id,
        headerMessageId: `m${id}@example.com`,
        subject: `Message ${id}`,
        author: 'Sender <sender@example.com>',
        recipients: ['Me <me@example.com>'],
        date: new Date(Date.UTC(2026, 0, 1) + id * 60000),
        folder,
      };
      messages.push(header);
      byId.set(id, header);
    }
    byFolder.set(folder.id, messages);
  }

  // Minimal pagination contract: a page carries a continuation token while
  // more messages remain, and no token on the last page.
  const pending = new Map();
  let seq = 0;
  function firstPage(items) {
    if (items.length <= pageSize) return { messages: items, id: null };
    const token = `t${(seq += 1)}`;
    pending.set(token, items.slice(pageSize));
    return { messages: items.slice(0, pageSize), id: token };
  }
  function nextPage(token) {
    const rest = pending.get(token) || [];
    pending.delete(token);
    return firstPage(rest);
  }

  let getFullCalls = 0;
  let queryCalls = 0;
  let listCalls = 0;

  const mailbox = {
    folders,
    folder(id) {
      return folders.find((f) => f.id === id || f.name === id);
    },
    messagesOf(name) {
      return byFolder.get(mailbox.folder(name).id) || [];
    },
    all() {
      return [...byId.values()];
    },
    getFullCalls: () => getFullCalls,
    queryCalls: () => queryCalls,
    listCalls: () => listCalls,
    // A test can hook the header walk to inject a pause at an exact point,
    // the way a UI click would arrive mid-walk.
    onList: null,
    total: byId.size,
  };

  const account = {
    id: 'acct',
    name: 'Work',
    identities: [{ email: 'me@example.com' }],
    folders,
  };

  globalThis.messenger = {
    storage: fakeStorage({
      settings: {
        bodyLimit: 4000,
        includeSpamTrash: false,
        indexEncryptedBodies: false,
        excludedAccounts: [],
      },
    }),
    accounts: { list: async () => [account] },
    folders: {
      getFolderInfo: async (id) => ({
        totalMessageCount: (byFolder.get(id) || []).length,
      }),
    },
    messages: {
      list: async (folderId) => {
        listCalls += 1;
        if (mailbox.onList) mailbox.onList();
        return firstPage(byFolder.get(folderId) || []);
      },
      continueList: async (token) => {
        listCalls += 1;
        if (mailbox.onList) mailbox.onList();
        return nextPage(token);
      },
      getFull: async (id) => {
        getFullCalls += 1;
        // Shape of a real getFull: a synthetic message/rfc822 wrapper around
        // the real root part.
        return {
          contentType: 'message/rfc822',
          parts: [
            {
              contentType: 'multipart/alternative',
              parts: [
                { contentType: 'text/plain', body: `Body of message ${id}`, parts: [] },
              ],
            },
          ],
        };
      },
      get: async (id) => byId.get(Number(id)) || null,
      query: async (opts) => {
        queryCalls += 1;
        const from = opts.fromDate ? new Date(opts.fromDate).getTime() : 0;
        const hits = [...byId.values()].filter(
          (h) => h.folder.accountId === opts.accountId && h.date.getTime() >= from
        );
        return firstPage(hits);
      },
    },
  };

  return mailbox;
}

// ---- real pipeline over that mailbox ----

function setup(mailboxOpts) {
  const box = fakeMailbox(mailboxOpts);
  // Fresh modules per test: the pause gate is module state, and a leaked
  // waiter from an earlier test would make the next one look stuck.
  loadLib('text', 'pause', 'index');
  loadIngest('extract', 'dockey', 'reader', 'events');
  const qdrant = fakeQdrant();
  const ollama = fakeOllama();
  globalThis.SarvaQdrant = qdrant;
  globalThis.SarvaOllama = ollama;
  installSettings();
  // The rebuild's extractor pool, without the workers: same function the
  // main-thread single-message path uses.
  const extractor = {
    run: async (mode, meta, full, indexEncrypted, maxBody) =>
      globalThis.SarvaExtract.buildDoc(meta, full, indexEncrypted, maxBody),
  };
  return { box, qdrant, ollama, extractor };
}

// ---- the gate itself ----

test('checkpoint is free while open and blocks while shut', async () => {
  loadLib('text', 'pause');
  const gate = globalThis.SarvaPause;

  assert.strictEqual(gate.isPaused(), false);
  assert.strictEqual(gate.checkpoint(), undefined, 'an unpaused checkpoint is synchronous');

  assert.strictEqual(gate.pause(), true, 'pause reports the change');
  assert.strictEqual(gate.pause(), false, 'pausing twice is not a change');
  assert.strictEqual(gate.isPaused(), true);

  let released = 0;
  async function held() {
    await gate.checkpoint();
    released += 1;
  }
  const promises = Array.from({ length: 8 }, held);
  await sleep(20);
  assert.strictEqual(released, 0, 'every checkpoint parked');

  assert.strictEqual(gate.resume(), true);
  await Promise.all(promises);
  assert.strictEqual(released, 8, 'resume released every waiter at once');
  assert.strictEqual(gate.resume(), false, 'resuming twice is not a change');
});

// The gate is shared by all loops, so a worker parked at a checkpoint must not
// swallow the resume signal meant for a later one.
test('a checkpoint opened while paused returns without waiting', async () => {
  loadLib('text', 'pause');
  const gate = globalThis.SarvaPause;
  gate.pause();
  const p = (async () => {
    await gate.checkpoint();
    return 'moved';
  })();
  assert.strictEqual(await Promise.race([p, sleep(10).then(() => 'held')]), 'held');
  gate.resume();
  assert.strictEqual(await p, 'moved');
});

// ---- rebuild ----

test('a rebuild paused before it starts reads no message bodies', async () => {
  const { box, extractor } = setup({ folderNames: ['Inbox'], perFolder: 30 });
  let ingested = 0;
  const sink = async (docs) => {
    ingested += docs.length;
  };

  globalThis.SarvaPause.pause();
  const build = globalThis.SarvaReader.fullBuild(extractor, sink, () => {});
  await sleep(40);
  assert.strictEqual(box.getFullCalls(), 0, 'no body read while paused');
  assert.strictEqual(ingested, 0);

  globalThis.SarvaPause.resume();
  const result = await build;
  assert.strictEqual(result.count, 30);
  assert.strictEqual(ingested, 30, 'every message reached the sink after resume');
});

test('pausing mid-rebuild stops the walk and resumes without losing a message', async () => {
  const { box, extractor } = setup({ folderNames: ['Inbox', 'Sent'], perFolder: 100 });
  const seen = [];
  let pausedOnce = false;
  const sink = async (docs) => {
    seen.push(...docs.map((d) => d.message_id));
    if (!pausedOnce) {
      pausedOnce = true;
      globalThis.SarvaPause.pause();
    }
  };

  const build = globalThis.SarvaReader.fullBuild(extractor, sink, () => {});
  const stopped = await settle(() => seen.length, { min: 1 });
  assert.ok(stopped < box.total, `held mid-walk (${stopped} of ${box.total} indexed)`);

  globalThis.SarvaPause.resume();
  const result = await build;

  assert.strictEqual(result.count, box.total, 'the rebuild finished the mailbox');
  assert.strictEqual(seen.length, box.total, 'no message was read twice or dropped');
  assert.strictEqual(new Set(seen).size, box.total, 'each message exactly once');
});

// ---- catch-up ----

test('a catch-up paused mid-walk indexes every message exactly once after resuming', async () => {
  // One big page: this pins the per-message checkpoint, not just the per-page
  // one — a hold must take effect inside a page, not after all of it.
  const { box, qdrant } = setup({ folderNames: ['Inbox', 'Sent'], perFolder: 100, pageSize: 200 });

  // Pause from the job's own progress callback, the way the UI would: the
  // signal arrives while the page is being read, not between pages.
  let pausedOnce = false;
  const run = globalThis.SarvaEvents.catchUp({}, (scanned) => {
    if (!pausedOnce && scanned > 0) {
      pausedOnce = true;
      globalThis.SarvaPause.pause();
    }
  });

  const stopped = await settle(() => box.getFullCalls(), { min: 1 });
  assert.ok(stopped < box.total, `held mid-page (${stopped} of ${box.total} bodies read)`);

  globalThis.SarvaPause.resume();
  const result = await run;

  assert.strictEqual(result.scanned, box.total);
  assert.strictEqual(result.added, box.total);
  assert.strictEqual(qdrant.points.size, box.total, 'one point per message, none duplicated');
  assert.strictEqual(box.getFullCalls(), box.total, 'no message was read twice');

  // The watermark may only advance on a completed walk — a pause is not a
  // failure, so it advances here.
  const marks = (await globalThis.messenger.storage.local.get('sarvasearch_watermarks'));
  assert.ok(marks.sarvasearch_watermarks.acct > 0, 'watermark advanced after the resumed run');
});

// ---- verify / repair ----

test('a verify paused during the walk resumes and repairs what is missing', async () => {
  const { box, qdrant } = setup({ folderNames: ['Inbox', 'Sent'], perFolder: 10 });
  const indexed = box.all().slice(0, 10);
  await globalThis.SarvaIndex.ingest(
    indexed.map((h) => ({
      message_id: h.headerMessageId,
      account_id: h.folder.accountId,
      account_name: 'Work',
      subject: h.subject,
      from: h.author,
      to: 'Me <me@example.com>',
      date: h.date.toISOString(),
      date_ms: h.date.getTime(),
      folder: h.folder.name,
      body: 'already indexed',
      snippet: 'already indexed',
      numeric_id: h.id,
      header_only: false,
      encrypted: false,
      attachments: [],
    }))
  );
  assert.strictEqual(qdrant.points.size, 10);

  let pausedOnce = false;
  let reachedHold;
  const holdPoint = new Promise((resolve) => {
    reachedHold = resolve;
  });
  const run = globalThis.SarvaEvents.reconcile((processed) => {
    // The walk reports per folder: pause on the first one, so the hold lands
    // in the collection phase, before anything is diffed or re-read.
    if (!pausedOnce && processed > 0) {
      pausedOnce = true;
      globalThis.SarvaPause.pause();
      reachedHold();
    }
  });

  await holdPoint;
  await sleep(30);
  assert.strictEqual(box.getFullCalls(), 0, 'paused before any repair read');
  assert.strictEqual(qdrant.points.size, 10, 'nothing written while held');
  await settle(() => qdrant.points.size);

  globalThis.SarvaPause.resume();
  const result = await run;

  assert.strictEqual(result.added, 10, 'the 10 missing messages were re-ingested');
  assert.strictEqual(result.removed, 0);
  assert.strictEqual(qdrant.points.size, box.total, 'index now matches the mailbox');
});

test('a verify held during the live-set walk stops walking', async () => {
  // 100 messages per folder in pages of 25: the walk is long enough that a
  // hold has to land inside it, not at the end.
  const { box, qdrant } = setup({ folderNames: ['Inbox', 'Sent'], perFolder: 100, pageSize: 25 });

  let pausedOnce = false;
  box.onList = () => {
    if (!pausedOnce && box.listCalls() >= 3) {
      pausedOnce = true;
      globalThis.SarvaPause.pause();
    }
  };

  const run = globalThis.SarvaEvents.reconcile();
  const stopped = await settle(() => box.listCalls(), { min: 1 });
  assert.ok(stopped < 8, `held mid-walk after ${stopped} header page(s)`);
  assert.strictEqual(box.getFullCalls(), 0, 'nothing was read while held');

  globalThis.SarvaPause.resume();
  const result = await run;

  assert.strictEqual(result.added, box.total, 'every missing message was re-ingested');
  assert.strictEqual(qdrant.points.size, box.total);
  assert.strictEqual(box.getFullCalls(), box.total, 'one read per message');
});

// ---- the job layer (background.js) ----
//
// The loops above prove the gate works; this proves the job around them does:
// a paused job still counts as running (so no second job starts), the badge
// says "paused" instead of holding a stale percentage, and the time spent held
// is accumulated rather than charged to the job's rate.

function loadBackground() {
  // Worker pool and badge are the only browser APIs background.js touches at
  // load time; everything else it needs is the add-on's own globals.
  globalThis.Worker = class {
    postMessage() {}
    set onmessage(_fn) {}
    set onerror(_fn) {}
  };

  const badge = { text: '', color: '' };
  let onMessage = null;
  globalThis.messenger = {
    storage: fakeStorage(),
    browserAction: {
      setTitle: async () => {},
      setBadgeText: async ({ text }) => {
        badge.text = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        badge.color = color;
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      getURL: (p) => `moz-extension://test/${p}`,
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener: () => {} } },
    messages: {},
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  (0, eval)(code);
  return { send: (msg) => onMessage(msg), badge };
}

test('a paused job stays running, blocks other jobs, and resumes where it stopped', async () => {
  loadLib('text', 'pause');
  let steps = 0;
  globalThis.SarvaReader = {
    // A long job in miniature: one checkpoint per "message", with a yield per
    // step so the test can get a pause in while it is still moving.
    fullBuild: async () => {
      for (let i = 0; i < 50; i += 1) {
        await globalThis.SarvaPause.checkpoint();
        steps += 1;
        await sleep(2);
      }
      return { count: steps, headerOnly: 0 };
    },
  };
  globalThis.SarvaEvents = {
    registerEvents: () => {},
    markAllCaughtUp: async () => {},
    catchUp: async () => ({ scanned: 0, added: 0 }),
    reconcile: async () => ({ added: 0, removed: 0, folders_updated: 0 }),
    clearWatermarks: async () => {},
  };
  globalThis.SarvaIndex = { ingest: async () => ({}), clear: async () => {}, stats: async () => ({ total_emails: 0 }) };
  globalThis.SarvaSettings = { ensure: async () => ({}) };

  const { send, badge } = loadBackground();

  const job = send({ type: 'rebuild' });
  await sleep(15);
  assert.ok(steps > 0 && steps < 50, `job is mid-flight (${steps} of 50)`);

  assert.deepStrictEqual(await send({ type: 'pause' }), { paused: true });
  assert.deepStrictEqual(await send({ type: 'pause' }), { paused: true, already: true });
  const held = await settle(() => steps, { min: 1 });
  assert.strictEqual(steps, held, 'the job stopped moving while held');
  assert.ok(held < 50, `held mid-job (${held} of 50)`);

  const status = await send({ type: 'getStatus' });
  assert.strictEqual(status.running, true, 'a paused job is still the running job');
  assert.strictEqual(status.paused, true);
  assert.ok(status.pausedAt > 0);
  await sleep(30); // let the badge renderer catch up

  assert.strictEqual(badge.text, 'II', 'the badge says held, not a stale percentage');
  assert.strictEqual((await send({ type: 'rebuild' })).reason, 'busy', 'no second job while paused');
  assert.strictEqual((await send({ type: 'clear' })).cleared, false, 'clearing under a held job is refused');

  assert.deepStrictEqual(await send({ type: 'resume' }), { resumed: true });
  const result = await job;

  assert.strictEqual(result.started, true);
  assert.strictEqual(steps, 50, 'the job finished the work it had left');
  const done = await send({ type: 'getStatus' });
  assert.strictEqual(done.running, false);
  assert.strictEqual(done.phase, 'idle');
  assert.strictEqual(done.paused, false);
  assert.ok(done.pausedMs >= 20, `held time is accounted for (${done.pausedMs}ms)`);

  await sleep(20);
  assert.strictEqual(badge.text, '', 'a finished job leaves the badge clear');
});

test('pausing when nothing is running is reported, not invented', async () => {
  loadLib('text', 'pause');
  globalThis.SarvaReader = { fullBuild: async () => ({ count: 0, headerOnly: 0 }) };
  globalThis.SarvaEvents = {
    registerEvents: () => {},
    markAllCaughtUp: async () => {},
    catchUp: async () => ({}),
    reconcile: async () => ({}),
    clearWatermarks: async () => {},
  };
  globalThis.SarvaIndex = { ingest: async () => ({}), clear: async () => {}, stats: async () => ({ total_emails: 1 }) };
  globalThis.SarvaSettings = { ensure: async () => ({}) };

  const { send } = loadBackground();
  assert.deepStrictEqual(await send({ type: 'pause' }), { paused: false, reason: 'idle' });
  assert.deepStrictEqual(await send({ type: 'resume' }), { resumed: false, reason: 'idle' });
  assert.strictEqual(globalThis.SarvaPause.isPaused(), false, 'an idle pause never shuts the gate');
});
