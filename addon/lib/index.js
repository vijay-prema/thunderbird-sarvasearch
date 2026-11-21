'use strict';
// The index itself: ingest, freshness bookkeeping, repairs. Exposes
// globalThis.SarvaIndex.
//
// Qdrant is the whole store: a message's point carries its payload, so the
// content hash and folder list live next to the vector and every rule below is
// expressed as "retrieve the point, compare, write back". There is no second
// database to keep in sync.
//
//   point id      uuid5(account|message-id)   stable identity, no local table
//   content_hash  sha256(embed text)          unchanged content is never re-embedded
//   folders       merged across copies        the point dies only with its last folder
//
// A point needs a vector, so a message the embedder refuses is skipped and
// remembered in a small failure map: not findable until the embedder accepts it,
// but not re-sent on every pass either.
(function () {
  const SNIPPET_LEN = 200;
  const FAIL_KEY = 'sarvasearch_embed_failures';
  const FAIL_MAX = 500;
  const UPSERT_BATCH = 100;
  const SCROLL_BATCH = 1000;

  function keyOf(payload) {
    return (payload.account || '') + '\u0000' + (payload.message_id || '');
  }

  // Embed-failure key: identity + content hash, so an edited message retries.
  function attemptKey(doc, hash) {
    return `${doc.account_id}\u0000${doc.message_id}\u0000${hash}`;
  }

  function payloadView(doc) {
    return {
      from: doc.from || '',
      to: doc.to || '',
      subject: doc.subject || '',
      date: doc.date || '',
      body: doc.body || '',
    };
  }

  function payloadOf(doc, folders, hash) {
    return {
      message_id: doc.message_id,
      account: doc.account_id,
      account_name: doc.account_name || '',
      subject: doc.subject || '',
      from: doc.from || '',
      to: doc.to || '',
      date: doc.date || '',
      date_ms: doc.date_ms || 0,
      folders,
      snippet: doc.snippet || SarvaText.snippetOf(doc, SNIPPET_LEN),
      body: doc.body || '',
      header_only: !!doc.header_only,
      encrypted: !!doc.encrypted,
      // Derived from the sender, so the notification filter is a bool match
      // instead of a token match on the from text (see lib/notify.js).
      notification: SarvaNotify.isNotification(doc.from),
      numeric_id: doc.numeric_id == null ? null : doc.numeric_id,
      attachments: doc.attachments || [],
      content_hash: hash,
      indexed_at: new Date().toISOString(),
    };
  }

  // ---- embed-failure map (bounded, keyed by content hash) ----

  async function loadFailures() {
    const r = await messenger.storage.local.get(FAIL_KEY);
    const list = (r && r[FAIL_KEY]) || [];
    return new Map(list);
  }

  async function saveFailures(map) {
    const entries = [...map.entries()].slice(-FAIL_MAX);
    await messenger.storage.local.set({ [FAIL_KEY]: entries });
  }

  // ---- collection readiness ----

  let ready = false;

  async function ensureReady() {
    if (ready) return;
    const dims = await SarvaOllama.dimensions();
    await SarvaQdrant.ensure(dims);
    ready = true;
  }

  function invalidate() {
    ready = false;
  }

  // ---- ingest ----

  // Batch upsert with per-document error isolation: if the batch is rejected,
  // retry each point alone so one poison payload cannot lose the other 99.
  async function upsertIsolated(points, result) {
    try {
      await SarvaQdrant.upsert(points);
      return;
    } catch (e) {
      if (points.length === 1) {
        result.failed += 1;
        console.warn('[SarvaSearch] skipped a message the index rejected:', e.message);
        return;
      }
    }
    let failures = 0;
    for (const point of points) {
      try {
        await SarvaQdrant.upsert([point]);
      } catch (e) {
        failures += 1;
        result.failed += 1;
        console.warn(
          '[SarvaSearch] skipped %s / %s: %s',
          point.payload.account,
          point.payload.message_id,
          e.message
        );
      }
    }
    if (failures === points.length) throw new Error('the index rejected every point — is Qdrant up?');
  }

  async function ingest(rawDocs) {
    await ensureReady();
    const docs = (rawDocs || []).map(SarvaText.repairDoc);
    const result = {
      received: docs.length,
      indexed: 0,
      updated: 0,
      folders_added: 0,
      unchanged: 0,
      embed_failed: 0,
      failed: 0,
    };
    if (!docs.length) return result;

    const ids = await Promise.all(docs.map((d) => SarvaText.pointId(d.account_id, d.message_id)));
    const prior = await SarvaQdrant.retrieve(ids);
    const priorByKey = new Map(prior.map((p) => [keyOf(p.payload || {}), p.payload || {}]));
    const hashes = await Promise.all(docs.map((d) => SarvaText.contentHash(payloadView(d))));
    const failures = await loadFailures();

    const jobs = []; // {doc, id, hash, folders}
    const patches = new Map(); // JSON payload -> {payload, ids: []}

    function patch(id, payload) {
      const sig = JSON.stringify(payload);
      const entry = patches.get(sig) || { payload, ids: [] };
      entry.ids.push(id);
      patches.set(sig, entry);
    }

    docs.forEach((doc, i) => {
      const id = ids[i];
      const hash = hashes[i];
      const before = priorByKey.get(keyOf({ account: doc.account_id, message_id: doc.message_id }));
      const folders = [doc.folder].filter(Boolean);

      if (!before) {
        jobs.push({ doc, id, hash, folders });
        return;
      }

      const priorFolders = Array.isArray(before.folders) ? before.folders : [];
      if (before.content_hash !== hash) {
        // Content changed (an edited draft): re-embed, keep the folder union.
        jobs.push({ doc, id, hash, folders: [...new Set([...priorFolders, ...folders])].sort() });
        return;
      }

      // ---- content unchanged: only metadata can move ----
      if (doc.account_name && doc.account_name !== (before.account_name || '')) {
        patch(id, { account_name: doc.account_name });
      }
      // The sender cannot have moved (it is part of the embed text, so a new
      // From would hash differently), which means this only fires for points
      // indexed before the flag existed: a rebuild backfills it without
      // re-embedding anything.
      const notification = SarvaNotify.isNotification(doc.from);
      if (before.notification !== notification) {
        patch(id, { notification });
      }
      // Attachment names are not part of the embed text, so a re-read that
      // finally sees them backfills without re-embedding. A non-empty list came
      // from a parsed MIME tree and is authoritative; an empty one is only
      // trustworthy when a body was actually read (a header-only read cannot
      // see the parts, and must not erase names recorded earlier).
      const priorAttachments = Array.isArray(before.attachments) ? before.attachments : [];
      const incoming = doc.attachments || [];
      const sameAttachments = JSON.stringify(incoming) === JSON.stringify(priorAttachments);
      if (!sameAttachments && (incoming.length > 0 || !doc.header_only)) {
        patch(id, { attachments: incoming });
      }

      const missingFolders = folders.filter((f) => !priorFolders.includes(f));
      if (!missingFolders.length) {
        result.unchanged += 1;
      } else {
        const merged = [...new Set([...priorFolders, ...folders])].sort();
        patch(id, { folders: merged });
        result.folders_added += 1;
      }
    });

    // ---- metadata writes, grouped by identical patch ----
    for (const { payload, ids: group } of patches.values()) {
      try {
        await SarvaQdrant.setPayload(group, payload);
      } catch (e) {
        console.warn('[SarvaSearch] metadata update failed for %d message(s): %s', group.length, e.message);
      }
    }

    // ---- embed + store ----
    if (jobs.length) {
      // Inputs Ollama already refused for this exact content are skipped, so a
      // poison message is not re-sent on every catch-up. A content change hashes
      // differently and gets a fresh attempt; Clear forgets the map.
      const attempt = jobs.filter(
        (j) => !failures.has(attemptKey(j.doc, j.hash))
      );
      result.embed_failed += jobs.length - attempt.length;

      const points = [];
      if (attempt.length) {
        const texts = attempt.map((j) => SarvaText.embedText(payloadView(j.doc)));
        const vectors = await SarvaOllama.embed(texts);

        attempt.forEach((job, i) => {
          const vector = vectors[i];
          if (!vector) {
            result.embed_failed += 1;
            failures.set(attemptKey(job.doc, job.hash), Date.now());
            return;
          }
          points.push({
            id: job.id,
            vector,
            payload: payloadOf(job.doc, job.folders, job.hash),
          });
          if (priorByKey.has(keyOf({ account: job.doc.account_id, message_id: job.doc.message_id }))) {
            result.updated += 1;
          } else {
            result.indexed += 1;
          }
        });
      }

      for (let i = 0; i < points.length; i += UPSERT_BATCH) {
        await upsertIsolated(points.slice(i, i + UPSERT_BATCH), result);
      }
    }

    if (result.embed_failed) await saveFailures(failures);
    return result;
  }

  // ---- one-time payload migrations ----
  // A payload field added after an index already exists is derivable from what
  // is stored there, so it is backfilled directly: no mail is re-read and
  // nothing is re-embedded. The run is recorded in storage, so it happens once
  // per index (Clear forgets the record along with everything else).
  const MIGRATIONS_KEY = 'sarvasearch_payload_migrations';

  // The notification flag (lib/notify.js) is a function of the stored sender.
  async function backfillNotifications() {
    const result = { scanned: 0, updated: 0 };
    let offset = null;
    for (;;) {
      const body = {
        limit: SCROLL_BATCH,
        with_payload: ['message_id', 'from', 'notification'],
        with_vector: false,
      };
      if (offset != null) body.offset = offset;
      const res = await SarvaQdrant.scroll(body);
      const page = (res && res.result) || {};
      // Grouped by the value each point needs, so a page costs at most two
      // payload writes rather than one per point.
      const patches = new Map();
      for (const p of page.points || []) {
        const pl = p.payload || {};
        if (!pl.message_id) continue;
        result.scanned += 1;
        const flag = SarvaNotify.isNotification(pl.from);
        if (pl.notification === flag) continue;
        const sig = String(flag);
        const entry = patches.get(sig) || { payload: { notification: flag }, ids: [] };
        entry.ids.push(p.id);
        patches.set(sig, entry);
      }
      for (const { payload, ids } of patches.values()) {
        await SarvaQdrant.setPayload(ids, payload);
        result.updated += ids.length;
      }
      offset = page.next_page_offset;
      if (!page.points || page.points.length === 0 || offset == null) break;
    }
    return result;
  }

  const MIGRATIONS = { 'notification-flag': backfillNotifications };
  // A rule change (lib/notify.js LOCAL_PATTERNS) renames the key — e.g.
  // 'notification-flag-2' — because the backfill only rewrites points whose
  // stored value disagrees, and indexes already marked done would otherwise
  // keep the old judgement.

  // Run whatever this index still owes. Returns null when there is nothing to
  // do (no collection yet, or everything already applied).
  async function runMigrations() {
    if (!(await SarvaQdrant.exists())) return null;
    const stored = await messenger.storage.local.get(MIGRATIONS_KEY);
    const done = new Set((stored && stored[MIGRATIONS_KEY]) || []);
    const pending = Object.keys(MIGRATIONS).filter((name) => !done.has(name));
    if (!pending.length) return null;
    const out = {};
    for (const name of pending) {
      out[name] = await MIGRATIONS[name]();
      done.add(name);
      // Recorded per migration: a later one failing must not repeat this one.
      await messenger.storage.local.set({ [MIGRATIONS_KEY]: [...done] });
    }
    return out;
  }

  // ---- reads ----

  // Which of these (account_id, message_id) pairs are already indexed? Used by
  // catch-up to skip a body read per message.
  async function known(items) {
    if (!items || !items.length) return [];
    const ids = await Promise.all(items.map((i) => SarvaText.pointId(i.account_id, i.message_id)));
    const found = await SarvaQdrant.retrieve(ids);
    return found
      .map((p) => p.payload || {})
      .filter((p) => p.account && p.message_id)
      .map((p) => ({ account_id: p.account, message_id: p.message_id }));
  }

  async function stats() {
    const zero = { total_emails: 0, header_only: 0, encrypted: 0, qdrant_points: 0, accounts: [] };
    if (!(await SarvaQdrant.exists())) return zero;
    const total = await SarvaQdrant.count();
    const headerOnly = await SarvaQdrant.count({ must: [{ key: 'header_only', match: { value: true } }] });
    const encrypted = await SarvaQdrant.count({ must: [{ key: 'encrypted', match: { value: true } }] });
    const hits = await SarvaQdrant.facet('account', 100);
    return {
      total_emails: total,
      header_only: headerOnly,
      encrypted,
      qdrant_points: total,
      accounts: hits.map((h) => ({ account_id: h.value, count: h.count })),
    };
  }

  async function health() {
    const [qdrant, ollama] = await Promise.all([SarvaQdrant.health(), SarvaOllama.health()]);
    let collection = 'missing';
    if (qdrant.ok) {
      try {
        const info = await SarvaQdrant.collectionInfo();
        collection = (info && info.result && info.result.status) || 'unknown';
      } catch (e) {
        collection = 'missing';
      }
    }
    return {
      qdrant: qdrant.ok ? 'ok' : 'error',
      qdrant_version: qdrant.version || '',
      collection,
      ollama: ollama.ok ? 'ok' : 'error',
    };
  }

  // ---- deletes ----

  async function deleteMessages(items) {
    const list = items || [];
    if (!list.length) return 0;
    const ids = await Promise.all(list.map((i) => SarvaText.pointId(i.account_id, i.message_id)));
    await SarvaQdrant.deletePoints(ids);
    return ids.length;
  }

  // A message moved out of a folder: drop that folder, and the point with it
  // when the last folder goes.
  async function removeFolder(items) {
    const result = { deleted: 0, updated: 0, missing: 0 };
    const list = items || [];
    if (!list.length) return result;
    const ids = await Promise.all(list.map((i) => SarvaText.pointId(i.account_id, i.message_id)));
    const found = new Map();
    for (const p of await SarvaQdrant.retrieve(ids)) found.set(p.id, p.payload || {});

    const toDelete = [];
    const patches = new Map();
    list.forEach((item, i) => {
      const payload = found.get(ids[i]);
      if (!payload) {
        result.missing += 1;
        return;
      }
      const remaining = (Array.isArray(payload.folders) ? payload.folders : []).filter((f) => f !== item.folder);
      if (!remaining.length) {
        toDelete.push(ids[i]);
        result.deleted += 1;
        return;
      }
      const sig = JSON.stringify(remaining);
      const entry = patches.get(sig) || { payload: { folders: remaining }, ids: [] };
      entry.ids.push(ids[i]);
      patches.set(sig, entry);
      result.updated += 1;
    });

    if (toDelete.length) await SarvaQdrant.deletePoints(toDelete);
    for (const { payload, ids: group } of patches.values()) await SarvaQdrant.setPayload(group, payload);
    return result;
  }

  // ---- reconcile ----

  // Everything the index currently holds, as (account, message_id, folders).
  async function allKeys() {
    const out = [];
    let offset = null;
    for (;;) {
      const body = { limit: SCROLL_BATCH, with_payload: ['account', 'message_id', 'folders'], with_vector: false };
      if (offset != null) body.offset = offset;
      const res = await SarvaQdrant.scroll(body);
      const page = (res && res.result) || {};
      for (const p of page.points || []) {
        const pl = p.payload || {};
        if (!pl.account || !pl.message_id) continue;
        out.push({ account_id: pl.account, message_id: pl.message_id, folders: pl.folders || [], id: p.id });
      }
      offset = page.next_page_offset;
      if (!page.points || page.points.length === 0 || offset == null) break;
    }
    return out;
  }

  // Diff the index against the live set. Deletes what the add-on no longer sees,
  // fixes folder drift, and returns what is missing so the caller can re-read it.
  async function reconcile(liveItems) {
    const live = new Map();
    for (const item of liveItems || []) live.set(keyOf({ account: item.account_id, message_id: item.message_id }), new Set(item.folders || []));
    const indexed = await allKeys();

    const toDelete = [];
    const patches = new Map();
    let foldersUpdated = 0;
    const seen = new Set();

    for (const row of indexed) {
      const key = keyOf({ account: row.account_id, message_id: row.message_id });
      seen.add(key);
      const want = live.get(key);
      if (!want) {
        toDelete.push(row.id);
        continue;
      }
      const have = row.folders.slice().sort();
      const wantSorted = [...want].sort();
      if (JSON.stringify(have) !== JSON.stringify(wantSorted)) {
        const sig = JSON.stringify(wantSorted);
        const entry = patches.get(sig) || { payload: { folders: wantSorted }, ids: [] };
        entry.ids.push(row.id);
        patches.set(sig, entry);
        foldersUpdated += 1;
      }
    }

    if (toDelete.length) {
      for (let i = 0; i < toDelete.length; i += 500) {
        await SarvaQdrant.deletePoints(toDelete.slice(i, i + 500));
      }
    }
    for (const { payload, ids: group } of patches.values()) await SarvaQdrant.setPayload(group, payload);

    const missing = [];
    for (const item of liveItems || []) {
      if (!seen.has(keyOf({ account: item.account_id, message_id: item.message_id }))) {
        missing.push({ account_id: item.account_id, message_id: item.message_id });
      }
    }
    return { deleted: toDelete.length, folders_updated: foldersUpdated, missing };
  }

  async function clear() {
    if (await SarvaQdrant.exists()) await SarvaQdrant.drop();
    invalidate();
    const dims = await SarvaOllama.dimensions();
    await SarvaQdrant.ensure(dims);
    ready = true;
    await messenger.storage.local.remove(FAIL_KEY);
    // A cleared index is rebuilt from scratch, so the one-time migrations owe
    // it nothing — forget that they ran, and the next startup applies them to
    // whatever the rebuild wrote.
    await messenger.storage.local.remove(MIGRATIONS_KEY);
    return true;
  }

  globalThis.SarvaIndex = {
    ingest,
    known,
    stats,
    health,
    deleteMessages,
    removeFolder,
    reconcile,
    allKeys,
    clear,
    ensureReady,
    invalidate,
    runMigrations,
    keyOf,
  };
})();
