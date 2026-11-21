#!/usr/bin/env node
'use strict';
// sarva — query the SarvaSearch index from outside Thunderbird.
//
// This is the agent/terminal face of the same index the addon fills. The
// ranking is not re-implemented here: tools/lib/runtime.js loads the addon's own
// lib/search.js, lib/qdrant.js and lib/ollama.js, so a result from this CLI is
// the result the search page would show.
//
//   sarva search "acme invoice" --limit 5
//   sarva search "power bill" --from example-powerco --after 2026-01-01 --latest
//   sarva search "invoice" --notifications only        (noreply@/alerts@/bounces@ …)
//   sarva show --account account2 --message-id 9F2C41A7-...@example.com
//   sarva open --account account2 --message-id 9F2C41A7-...      (opens in Thunderbird)
//   sarva url --account account2 --message-id 9F2C41A7-...       (clickable link only)
//   sarva stats | accounts | doctor
//
// Every result carries a `url` that opens the message in Thunderbird through the
// bridge daemon (tools/bridge.js). With --json the whole result set is machine
// readable; that is the form an agent should consume.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadRuntime, configPath } = require('./lib/runtime');

const MODES = new Set(['hybrid', 'semantic', 'keyword']);

// ---- bridge daemon lifecycle -------------------------------------------------
//
// A WebExtension cannot start a process, so the daemon has to be started from
// out here — and the natural moment is the one where it matters: a command that
// is about to hand out clickable links (search) or open a message (open). The
// daemon is spawned detached, so it outlives the tool call that started it and
// keeps running until logout (a failed connection from a later session simply
// respawns it). `doctor` never spawns anything, and --no-daemon turns it off.

function bridgeBase(rt) {
  return String(rt.rawConfig.bridgeUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

async function probeBridge(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// A freshly spawned daemon has no client until the add-on's next long poll
// lands, so give it a moment: otherwise `open` reports a timeout that is
// really just "the add-on has not polled yet". The request is queued either
// way — the add-on opens it whenever it next connects.
async function waitForClient(base, tries = 16, gapMs = 500) {
  let health = await probeBridge(base);
  for (let i = 0; i < tries && health && !(health.waiting_clients > 0); i += 1) {
    await new Promise((r) => setTimeout(r, gapMs));
    health = await probeBridge(base);
  }
  return { clients: (health && health.waiting_clients) || 0, health };
}

function launchBridge(base, token) {
  const url = new URL(base);
  const args = [
    path.join(__dirname, 'bridge.js'),
    'serve',
    '--port',
    String(url.port || 8765),
    '--host',
    url.hostname,
    '--quiet',
  ];
  if (token) args.push('--token', String(token));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// Returns {running, started, pid?, health?, error?}. Injecting probe/launch keeps
// the decision logic testable without ports or processes.
async function ensureDaemon(rt, opts = {}) {
  const base = bridgeBase(rt);
  const probe = opts.probe || probeBridge;
  const launch = opts.launch || launchBridge;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const already = await probe(base);
  if (already) return { running: true, started: false, base, health: already, clients: already.waiting_clients || 0 };
  if (opts.allow === false) return { running: false, started: false, base, error: 'daemon not running (--no-daemon)' };

  const pid = launch(base, rt.rawConfig.bridgeToken);
  for (let i = 0; i < 25; i += 1) {
    await sleep(100);
    const health = await probe(base);
    if (health) return { running: true, started: true, pid, base, health, clients: health.waiting_clients || 0 };
  }
  return { running: false, started: true, pid, base, error: 'daemon did not answer after starting' };
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const boolKeys = new Set(['json', 'latest', 'window', 'help', 'quiet', 'no-daemon']);
    if (next === undefined || next.startsWith('--')) {
      out.flags[key] = boolKeys.has(key) ? true : true;
    } else if (boolKeys.has(key)) {
      out.flags[key] = true;
    } else {
      out.flags[key] = next;
      i += 1;
    }
  }
  return out;
}

function usage() {
  return `sarva — search the local SarvaSearch mail index

  sarva search <query...> [options]
      --mode hybrid|semantic|keyword   default hybrid
      --limit N                        results (1-100, default from settings)
      --account ID                     restrict to one Thunderbird account id
      --from TEXT                      sender filter (token match, e.g. "acme")
      --to TEXT                        recipient filter
      --notifications only|exclude     keep only notification senders (noreply@,
                                       notifications@, bounces@ …) or drop them
      --attachments only|exclude       keep only messages carrying attachments,
                                       or drop them
      --after YYYY-MM-DD               inclusive lower bound on the Date header
      --before YYYY-MM-DD              inclusive upper bound
      --latest                         keep the matched set, order newest first
      --json                           machine-readable output
      --no-daemon                      do not start the bridge daemon for the links

  sarva show --account ID --message-id ID [--json]
      Full stored record: subject, addresses, folders, attachments and the
      indexed body text (truncated at the addon's bodyLimit, typically 4000).

  sarva open --account ID --message-id ID [--window] [--json]
      Ask Thunderbird to open the message (needs the bridge daemon + GUI TB).

  sarva url --account ID --message-id ID
      Print just the clickable bridge URL.

  sarva stats | accounts | doctor | serve [--port N]

Config: ${configPath()} (qdrantUrl, collection, ollamaUrl, ollamaModel,
bridgeUrl, keywordWeights, rrfK, ...). Missing values fall back to the addon
defaults.`;
}

function fmtDate(value, ms) {
  const d = value ? new Date(value) : ms ? new Date(ms) : null;
  if (!d || Number.isNaN(d.getTime())) return '           ';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function truncate(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function openUrl(rt, result, location) {
  const base = bridgeBase(rt);
  const params = new URLSearchParams({
    account: result.account || '',
    message_id: result.message_id || '',
  });
  if (location === 'window') params.set('location', 'window');
  return `${base}/open?${params.toString()}`;
}

async function cmdSearch(rt, args) {
  const query = args._.join(' ').trim();
  if (!query) throw new Error('search needs a query, e.g. sarva search "rates notice"');
  const f = args.flags;
  const mode = f.mode || undefined;
  if (mode && !MODES.has(mode)) throw new Error(`--mode must be one of ${[...MODES].join(', ')}`);
  const notifications = f.notifications || undefined;
  if (notifications && notifications !== 'only' && notifications !== 'exclude') {
    throw new Error('--notifications must be only or exclude');
  }
  const attachments = f.attachments || undefined;
  if (attachments && attachments !== 'only' && attachments !== 'exclude') {
    throw new Error('--attachments must be only or exclude');
  }

  const settings = await rt.SarvaSettings.get();
  const req = {
    query,
    mode,
    latest: !!f.latest,
    limit: f.limit ? Number(f.limit) : undefined,
    account: f.account || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    notifications,
    attachments,
    after: f.after || undefined,
    before: f.before || undefined,
    settings,
  };

  // The links this command prints are only clickable while a daemon is up, so
  // make sure one is: spawn it now if nothing is listening, and say so on stderr
  // (stdout stays clean for --json consumers).
  const bridge = await ensureDaemon(rt, { allow: !f['no-daemon'] });

  const out = await rt.SarvaSearch.search(req);
  const results = out.results.map((r, i) => ({
    rank: i + 1,
    score: Number(r.score.toFixed(6)),
    engines: r.engines,
    account: r.account,
    account_name: r.account_name,
    message_id: r.message_id,
    subject: r.subject,
    from: r.from,
    to: r.to,
    date: r.date,
    date_ms: r.date_ms,
    folders: r.folders,
    snippet: r.snippet,
    header_only: r.header_only,
    encrypted: r.encrypted,
    attachments: r.attachments,
    url: openUrl(rt, r, f.window ? 'window' : 'tab'),
  }));

  const payload = {
    query: out.query,
    mode: out.mode,
    mode_used: out.mode_used,
    latest: out.latest,
    notifications: out.notifications,
    attachments: out.attachments,
    engines: out.engines,
    count: results.length,
    bridge: { running: bridge.running, started: bridge.started, url: bridge.base, clients: bridge.clients || 0 },
    results,
  };

  if (f.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  if (bridge.started && bridge.running) {
    process.stderr.write(`(started bridge daemon at ${bridge.base}, pid ${bridge.pid} — links are live)\n`);
  } else if (!bridge.running) {
    process.stderr.write(`(bridge daemon not running: ${bridge.error || 'unknown'} — links will not open)\n`);
  }
  const semNote = out.engines.semantic.available ? `sem ${out.engines.semantic.candidates}` : 'sem unavailable';
  const notes = [];
  if (out.notifications === 'only') notes.push('notifications only');
  else if (out.notifications === 'exclude') notes.push('notifications hidden');
  if (out.attachments === 'only') notes.push('with attachments');
  else if (out.attachments === 'exclude') notes.push('without attachments');
  const notifyNote = notes.length ? ` · ${notes.join(' · ')}` : '';
  console.log(
    `\nSearch “${out.query}”  ·  ${out.mode_used}${out.latest ? ' · latest' : ''}${notifyNote}  ·  ` +
      `${results.length} result${results.length === 1 ? '' : 's'}  (${semNote} · kw ${out.engines.keyword.candidates})\n`
  );
  if (!results.length) {
    console.log('  No matches. Try --mode keyword, drop a filter, or check that the index is built (sarva stats).\n');
    return payload;
  }

  for (const r of results) {
    const engine = [];
    if (r.engines.semantic) engine.push(`sem ${Number(r.engines.semantic.score).toFixed(3)} (#${r.engines.semantic.rank})`);
    if (r.engines.keyword) engine.push(`kw #${r.engines.keyword.rank}`);
    const where = [r.account_name || r.account, (r.folders || []).join(',')].filter(Boolean).join(' / ');
    const flags = [r.header_only ? 'header-only' : '', r.encrypted ? 'encrypted' : ''].filter(Boolean).join(' ');
    console.log(` ${String(r.rank).padStart(2)}  ${fmtDate(r.date, r.date_ms)}  ${truncate(r.subject, 90) || '(no subject)'}`);
    console.log(`     ${truncate(r.from, 70)}${where ? `  ·  ${where}` : ''}${flags ? `  ·  ${flags}` : ''}`);
    console.log(`     ${engine.join(' · ')}  ·  score ${r.score}${r.attachments && r.attachments.length ? `  ·  ${r.attachments.length} attachment(s)` : ''}`);
    if (r.snippet) console.log(`     ${truncate(r.snippet, 160)}`);
    console.log(`     ${r.url}\n`);
  }
  return payload;
}

async function findPayload(rt, account, messageId) {
  if (!messageId) throw new Error('need --message-id');
  if (account) {
    const id = await rt.SarvaText.pointId(account, messageId);
    const [hit] = await rt.SarvaQdrant.retrieve([id]);
    return hit || null;
  }
  const res = await rt.SarvaQdrant.scroll({
    limit: 5,
    with_payload: true,
    with_vector: false,
    filter: { must: [{ key: 'message_id', match: { value: messageId } }] },
  });
  const points = (res && res.result && res.result.points) || [];
  return points[0] || null;
}

async function cmdShow(rt, args) {
  const f = args.flags;
  const hit = await findPayload(rt, f.account, f['message-id'] || f.message_id || args._[0]);
  if (!hit) throw new Error('message not in the index (wrong account, or never indexed)');
  const p = hit.payload || {};
  const body = p.body || '';
  const cap = Number((await rt.SarvaSettings.get()).bodyLimit || 4000);
  const record = {
    point_id: hit.id,
    account: p.account,
    account_name: p.account_name,
    message_id: p.message_id,
    subject: p.subject,
    from: p.from,
    to: p.to,
    date: p.date,
    date_ms: p.date_ms,
    folders: p.folders || [],
    attachments: p.attachments || [],
    header_only: !!p.header_only,
    encrypted: !!p.encrypted,
    numeric_id: p.numeric_id,
    content_hash: p.content_hash,
    indexed_at: p.indexed_at,
    body,
    body_truncated: body.length >= cap,
    url: openUrl(rt, p),
  };
  if (f.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record;
  }
  console.log(`\n${record.subject || '(no subject)'}`);
  console.log(`  from     ${record.from}`);
  console.log(`  to       ${record.to}`);
  console.log(`  date     ${fmtDate(record.date, record.date_ms)}  (${record.date})`);
  console.log(`  account  ${record.account_name || record.account}  ·  ${record.folders.join(', ') || 'no folder'}`);
  if (record.attachments.length) console.log(`  attach   ${record.attachments.join(', ')}`);
  if (record.header_only) console.log('  note     header-only: the body was never downloaded, so it is not indexed');
  console.log(`  open     ${record.url}\n`);
  console.log(body || '(no body text indexed)');
  if (record.body_truncated) {
    console.log(`\n[body truncated at the indexer's ${cap}-character limit — the full message is in Thunderbird, via the link above]`);
  }
  console.log('');
  return record;
}

async function cmdOpen(rt, args) {
  const f = args.flags;
  const messageId = f['message-id'] || f.message_id || args._[0];
  if (!messageId) throw new Error('need --message-id');
  const bridge = await ensureDaemon(rt, { allow: !f['no-daemon'] });
  if (!bridge.running) throw new Error(`bridge daemon unavailable: ${bridge.error || 'unknown'}`);
  if (bridge.started) {
    process.stderr.write(`(started bridge daemon at ${bridge.base}, pid ${bridge.pid})\n`);
    // The add-on reconnects on its own long-poll cycle (25 s), so a freshly
    // started daemon has no client yet: say that instead of waiting for a
    // timeout that looks like a broken installation.
    const waited = await waitForClient(bridge.base);
    if (!waited.clients) {
      process.stderr.write('(no Thunderbird client attached yet — is Thunderbird running with the add-on enabled?)\n');
    }
  }
  const base = bridge.base;
  const body = {
    account: f.account || '',
    message_id: messageId,
    location: f.window ? 'window' : 'tab',
    wait: f.wait ? Number(f.wait) : 10,
  };
  let res;
  try {
    res = await fetch(`${base}/open?format=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((body.wait + 10) * 1000),
    });
  } catch (e) {
    throw new Error(
      `bridge daemon not reachable at ${base} — start it with: node tools/bridge.js serve  (${e.message})`
    );
  }
  const out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (f.json) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out;
  }
  if (out.ok) console.log(`opened in Thunderbird: ${messageId}`);
  else console.log(`could not open ${messageId}: ${out.error || `HTTP ${res.status}`}`);
  return out;
}

function cmdUrl(rt, args) {
  const f = args.flags;
  const messageId = f['message-id'] || f.message_id || args._[0];
  if (!messageId) throw new Error('need --message-id');
  console.log(openUrl(rt, { account: f.account || '', message_id: messageId }, f.window ? 'window' : 'tab'));
}

async function cmdStats(rt, args) {
  const q = rt.SarvaQdrant;
  if (!(await q.exists())) throw new Error(`collection "${(await rt.SarvaSettings.get()).collection}" does not exist — build the index in Thunderbird first`);
  const total = await q.count();
  const headerOnly = await q.count({ must: [{ key: 'header_only', match: { value: true } }] });
  const encrypted = await q.count({ must: [{ key: 'encrypted', match: { value: true } }] });
  const hits = await q.facet('account', 100);
  const accounts = [];
  for (const h of hits) {
    let name = '';
    try {
      const res = await q.scroll({
        limit: 1,
        with_payload: ['account_name'],
        with_vector: false,
        filter: { must: [{ key: 'account', match: { value: h.value } }] },
      });
      const [p] = (res && res.result && res.result.points) || [];
      name = (p && p.payload && p.payload.account_name) || '';
    } catch (e) {
      /* name is cosmetic */
    }
    accounts.push({ account: h.value, account_name: name, count: h.count });
  }
  const payload = { total, header_only: headerOnly, encrypted, accounts };
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`\n${total.toLocaleString()} messages indexed  (${headerOnly} header-only, ${encrypted} encrypted)\n`);
  for (const a of accounts) {
    console.log(`  ${String(a.count).padStart(7)}  ${a.account}${a.account_name ? `  (${a.account_name})` : ''}`);
  }
  console.log('');
  return payload;
}

async function cmdAccounts(rt, args) {
  return cmdStats(rt, args);
}

async function cmdDoctor(rt, args) {
  const s = await rt.SarvaSettings.get();
  const out = { config: configPath(), settings: { qdrantUrl: s.qdrantUrl, collection: s.collection, ollamaUrl: s.ollamaUrl, ollamaModel: s.ollamaModel, bridgeUrl: s.bridgeUrl } };
  const check = async (fn) => {
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  out.qdrant = await check(async () => ({ version: await rt.SarvaQdrant.version() }));
  out.collection = await check(async () => ({ points: await rt.SarvaQdrant.count() }));
  out.ollama = await check(async () => {
    const tags = await rt.SarvaHttp.request(`${String(s.ollamaUrl).replace(/\/+$/, '')}/api/tags`, { timeoutMs: 5000, retries: 0 });
    const names = ((tags && tags.models) || []).map((m) => m.name);
    const model = names.find((n) => n === s.ollamaModel || n.startsWith(`${s.ollamaModel}:`));
    if (!model) throw new Error(`model ${s.ollamaModel} is not pulled`);
    return { model, models: names.length };
  });
  out.bridge = await check(async () => {
    const res = await rt.SarvaHttp.request(`${String(s.bridgeUrl).replace(/\/+$/, '')}/health`, { timeoutMs: 3000, retries: 0 });
    return { queued: res.queued, clients: res.waiting_clients, served: res.stats && res.stats.enqueued };
  });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out;
  }
  const mark = (ok) => (ok ? 'ok  ' : 'FAIL');
  console.log(`\nconfig      ${out.config}`);
  console.log(`${mark(out.qdrant.ok)}  qdrant     ${s.qdrantUrl}${out.qdrant.ok ? ` (v${out.qdrant.version})` : ` — ${out.qdrant.error}`}`);
  console.log(`${mark(out.collection.ok)}  collection ${s.collection}${out.collection.ok ? ` — ${out.collection.points.toLocaleString()} points` : ` — ${out.collection.error}`}`);
  console.log(`${mark(out.ollama.ok)}  ollama     ${s.ollamaUrl}${out.ollama.ok ? ` — ${out.ollama.model}` : ` — ${out.ollama.error}`}`);
  console.log(`${mark(out.bridge.ok)}  bridge     ${s.bridgeUrl}${out.bridge.ok ? ` — ${out.bridge.clients} client(s)` : ` — ${out.bridge.error} (semantic/keyword search still works)`}`);
  console.log('');
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._.shift() || 'help';
  if (cmd === 'help' || args.flags.help) {
    console.log(usage());
    return 0;
  }
  if (cmd === 'serve') {
    // `sarva serve` is the bridge daemon under a shorter name.
    require('./bridge.js').main(argv.slice(1));
    return new Promise(() => {}); // the listening server keeps the process alive
  }

  const rt = loadRuntime();
  switch (cmd) {
    case 'search':
      await cmdSearch(rt, args);
      break;
    case 'show':
      await cmdShow(rt, args);
      break;
    case 'open':
      await cmdOpen(rt, args);
      break;
    case 'url':
      cmdUrl(rt, args);
      break;
    case 'stats':
    case 'accounts':
      await cmdStats(rt, args);
      break;
    case 'doctor':
      await cmdDoctor(rt, args);
      break;
    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(usage());
      return 2;
  }
  return 0;
}

module.exports = { main, parseArgs, openUrl, fmtDate, ensureDaemon, probeBridge, bridgeBase, waitForClient };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === 'number' && code !== 0) process.exit(code);
    })
    .catch((e) => {
      console.error(`sarva: ${e.message}`);
      process.exit(1);
    });
}
