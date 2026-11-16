#!/usr/bin/env node
'use strict';
// End-to-end check: load the add-on's REAL modules in Node and drive them
// against your running Qdrant + Ollama. This is the closest thing to running
// inside Thunderbird that can be automated — same code, same endpoints.
//
//   node tools/verify-live.js                 # search the live index
//   node tools/verify-live.js --roundtrip     # also ingest/repair/delete a
//                                             # throwaway collection
//
// Exit code 0 = every check passed.

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'addon', 'lib');
const ROUNDTRIP = process.argv.includes('--roundtrip');

// Minimal messenger stand-in: the lib modules only ever touch storage.local.
const store = {};
globalThis.messenger = {
  storage: {
    local: {
      get: async (key) => {
        if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
        return { ...store };
      },
      set: async (obj) => Object.assign(store, obj),
      remove: async (key) => delete store[key],
    },
  },
};

for (const name of ['http', 'settings', 'text', 'qdrant', 'ollama', 'index', 'search']) {
  (0, eval)(fs.readFileSync(path.join(LIB, `${name}.js`), 'utf8'));
}

const QDRANT = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const COLLECTION = process.env.COLLECTION || 'ai_omnisearch';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function configure(collection) {
  await globalThis.AIOSSettings.save({ qdrantUrl: QDRANT, ollamaUrl: OLLAMA, collection });
  globalThis.AIOSIndex.invalidate();
}

async function show(label, res, ms) {
  console.log(`\n${label} — ${res.mode_used}, ${res.results.length} results in ${ms}ms`);
  for (const r of res.results.slice(0, 3)) {
    const sem = r.engines.semantic ? `sem#${r.engines.semantic.rank}` : 'sem-';
    const kw = r.engines.keyword ? `kw#${r.engines.keyword.rank}` : 'kw-';
    console.log(`   ${sem} ${kw}  ${(r.subject || '(no subject)').slice(0, 58)}  <${(r.from || '').slice(0, 28)}>`);
  }
}

async function timed(fn) {
  const t0 = Date.now();
  const out = await fn();
  return [out, Date.now() - t0];
}

async function main() {
  await configure(COLLECTION);

  const health = await globalThis.AIOSIndex.health();
  console.log(`qdrant=${health.qdrant} ${health.qdrant_version} collection=${health.collection} ollama=${health.ollama}`);
  check('Qdrant reachable', health.qdrant === 'ok');
  check('collection loaded', health.collection === 'green' || health.collection === 'yellow', health.collection);
  check('Ollama reachable', health.ollama === 'ok');

  const stats = await globalThis.AIOSIndex.stats();
  console.log(`indexed: ${stats.total_emails} messages, ${stats.header_only} header-only, ${stats.encrypted} encrypted`);
  console.log(`accounts: ${stats.accounts.map((a) => `${a.account_id}=${a.count}`).join(' ')}`);
  check('index has messages', stats.total_emails > 0, String(stats.total_emails));

  for (const [mode, query] of [['keyword', 'invo'], ['semantic', 'plumbing invoice'], ['hybrid', 'acme invoice']]) {
    const [res, ms] = await timed(() => globalThis.AIOSSearch.search({ query, mode, limit: 5 }));
    await show(`${mode}: ${JSON.stringify(query)}`, res, ms);
    check(`${mode} search returned results`, res.results.length > 0);
    check(`${mode} results carry payload fields`,
      res.results.every((r) => r.message_id && r.account && typeof r.date_ms === 'number'));
  }

  const [filtered, fms] = await timed(() =>
    globalThis.AIOSSearch.search({ query: 'invoice', mode: 'hybrid', limit: 5, from: 'acme', after: '2024-01-01' })
  );
  await show(`filtered: invoice from:acme after:2024-01-01`, filtered, fms);
  check('from filter only returns that sender',
    filtered.results.every((r) => r.from.toLowerCase().includes('acme')), `${filtered.results.length} results`);

  const keywords = await timed(() => globalThis.AIOSSearch.search({ query: 'invo', mode: 'keyword', limit: 5 }));
  check('prefix query "invo" matched (search-as-you-type)', keywords[0].results.length > 0, `${keywords[1]}ms`);

  if (!ROUNDTRIP) return;

  // ---- write path against a throwaway collection ----
  const TMP = 'aios_verify_tmp';
  await configure(TMP);
  await globalThis.AIOSIndex.clear();
  const doc = (over) => ({
    message_id: 'verify-1@example.com',
    account_id: 'verify-acct',
    account_name: 'Verify',
    subject: 'Quarterly plumbing invoice',
    from: 'Priya <priya@example.com>',
    to: 'Me <me@example.com>',
    date: '2026-02-01T00:00:00.000Z',
    date_ms: Date.UTC(2026, 1, 1),
    folder: 'Inbox',
    body: 'Please find attached the invoice for the quarterly maintenance.',
    snippet: 'Please find attached the invoice',
    numeric_id: null,
    header_only: false,
    encrypted: false,
    attachments: [],
    ...over,
  });

  let r = await globalThis.AIOSIndex.ingest([doc()]);
  check('ingest stores a new message', r.indexed === 1, JSON.stringify(r));

  r = await globalThis.AIOSIndex.ingest([doc({ folder: 'Sent' })]);
  check('re-ingest merges the folder instead of re-embedding', r.folders_added === 1 && r.unchanged === 0, JSON.stringify(r));

  const hit = await globalThis.AIOSSearch.search({ query: 'invoice', mode: 'hybrid', limit: 3 });
  check('hybrid search finds the ingested message', hit.results.some((x) => x.message_id === 'verify-1@example.com'));
  check('folders merged on the stored point',
    hit.results[0] && hit.results[0].folders.join(',') === 'Inbox,Sent', JSON.stringify(hit.results[0] && hit.results[0].folders));

  const rec = await globalThis.AIOSIndex.reconcile([
    { account_id: 'verify-acct', message_id: 'verify-1@example.com', folders: ['Inbox', 'Sent'] },
    { account_id: 'verify-acct', message_id: 'verify-missing@example.com', folders: ['Inbox'] },
  ]);
  check('reconcile reports the missing message', rec.missing.length === 1, JSON.stringify(rec));

  r = await globalThis.AIOSIndex.removeFolder([{ account_id: 'verify-acct', message_id: 'verify-1@example.com', folder: 'Inbox' }]);
  check('removing one folder keeps the point', r.updated === 1, JSON.stringify(r));
  r = await globalThis.AIOSIndex.removeFolder([{ account_id: 'verify-acct', message_id: 'verify-1@example.com', folder: 'Sent' }]);
  check('removing the last folder deletes the point', r.deleted === 1, JSON.stringify(r));

  await globalThis.AIOSIndex.clear();
  check('clear empties the collection', (await globalThis.AIOSIndex.stats()).total_emails === 0);
  await configure(COLLECTION);
}

main()
  .catch((e) => {
    console.error('ERROR', e.message);
    failures += 1;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
