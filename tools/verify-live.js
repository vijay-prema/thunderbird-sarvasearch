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
const COLLECTION = process.env.COLLECTION || 'sarvasearch';

// Checks that need a known correspondent in the real index take it from here,
// so the repo never names a real sender. Set SARVA_VERIFY_SENDER (a token that
// appears in at least one sender) to exercise the from-filter check; without it
// that one check is skipped rather than silently passing on zero results.
const VERIFY_SENDER = process.env.SARVA_VERIFY_SENDER || '';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function configure(collection) {
  await globalThis.SarvaSettings.save({ qdrantUrl: QDRANT, ollamaUrl: OLLAMA, collection });
  globalThis.SarvaIndex.invalidate();
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

  const health = await globalThis.SarvaIndex.health();
  console.log(`qdrant=${health.qdrant} ${health.qdrant_version} collection=${health.collection} ollama=${health.ollama}`);
  check('Qdrant reachable', health.qdrant === 'ok');
  check('collection loaded', health.collection === 'green' || health.collection === 'yellow', health.collection);
  check('Ollama reachable', health.ollama === 'ok');

  const stats = await globalThis.SarvaIndex.stats();
  console.log(`indexed: ${stats.total_emails} messages, ${stats.header_only} header-only, ${stats.encrypted} encrypted`);
  console.log(`accounts: ${stats.accounts.map((a) => `${a.account_id}=${a.count}`).join(' ')}`);
  check('index has messages', stats.total_emails > 0, String(stats.total_emails));

  for (const [mode, query] of [['keyword', 'invo'], ['semantic', 'plumbing invoice'], ['hybrid', 'quarterly invoice']]) {
    const [res, ms] = await timed(() => globalThis.SarvaSearch.search({ query, mode, limit: 5 }));
    await show(`${mode}: ${JSON.stringify(query)}`, res, ms);
    check(`${mode} search returned results`, res.results.length > 0);
    check(`${mode} results carry payload fields`,
      res.results.every((r) => r.message_id && r.account && typeof r.date_ms === 'number'));
  }

  if (!VERIFY_SENDER) {
    console.log('\nskip  from-filter check — set SARVA_VERIFY_SENDER to a sender token in your index');
  } else {
    const [filtered, fms] = await timed(() =>
      globalThis.SarvaSearch.search({ query: 'invoice', mode: 'hybrid', limit: 5, from: VERIFY_SENDER, after: '2024-01-01' })
    );
    await show(`filtered: invoice from:${VERIFY_SENDER} after:2024-01-01`, filtered, fms);
    check('from filter returns results',
      filtered.results.length > 0, `${filtered.results.length} results`);
    check('from filter only returns that sender',
      filtered.results.every((r) => r.from.toLowerCase().includes(VERIFY_SENDER.toLowerCase())), `${filtered.results.length} results`);
  }

  const keywords = await timed(() => globalThis.SarvaSearch.search({ query: 'invo', mode: 'keyword', limit: 5 }));
  check('prefix query "invo" matched (search-as-you-type)', keywords[0].results.length > 0, `${keywords[1]}ms`);

  if (!ROUNDTRIP) return;

  // ---- write path against a throwaway collection ----
  const TMP = 'sarvasearch_verify_tmp';
  await configure(TMP);
  await globalThis.SarvaIndex.clear();
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

  let r = await globalThis.SarvaIndex.ingest([doc()]);
  check('ingest stores a new message', r.indexed === 1, JSON.stringify(r));

  r = await globalThis.SarvaIndex.ingest([doc({ folder: 'Sent' })]);
  check('re-ingest merges the folder instead of re-embedding', r.folders_added === 1 && r.unchanged === 0, JSON.stringify(r));

  const hit = await globalThis.SarvaSearch.search({ query: 'invoice', mode: 'hybrid', limit: 3 });
  check('hybrid search finds the ingested message', hit.results.some((x) => x.message_id === 'verify-1@example.com'));
  check('folders merged on the stored point',
    hit.results[0] && hit.results[0].folders.join(',') === 'Inbox,Sent', JSON.stringify(hit.results[0] && hit.results[0].folders));

  const rec = await globalThis.SarvaIndex.reconcile([
    { account_id: 'verify-acct', message_id: 'verify-1@example.com', folders: ['Inbox', 'Sent'] },
    { account_id: 'verify-acct', message_id: 'verify-missing@example.com', folders: ['Inbox'] },
  ]);
  check('reconcile reports the missing message', rec.missing.length === 1, JSON.stringify(rec));

  r = await globalThis.SarvaIndex.removeFolder([{ account_id: 'verify-acct', message_id: 'verify-1@example.com', folder: 'Inbox' }]);
  check('removing one folder keeps the point', r.updated === 1, JSON.stringify(r));
  r = await globalThis.SarvaIndex.removeFolder([{ account_id: 'verify-acct', message_id: 'verify-1@example.com', folder: 'Sent' }]);
  check('removing the last folder deletes the point', r.deleted === 1, JSON.stringify(r));

  await globalThis.SarvaIndex.clear();
  check('clear empties the collection', (await globalThis.SarvaIndex.stats()).total_emails === 0);
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
