'use strict';
// Reads mail through the Thunderbird WebExtension API — the mail Thunderbird
// has already downloaded — and turns messages into docs for the search
// server. No IMAP, no Gloda: we walk folders and read bodies ourselves.
//
// The pipeline shape (READ_CONCURRENCY workers overlapping getFull I/O and
// worker-pool extraction, batched flushes) is ported from
// CR0CKER/thunderbird-omnisearch (MIT) — its lib/indexer.js — with the
// flush target changed from its local MiniSearch engine to the search
// server's /ingest endpoint. Exposes globalThis.AIOSReader.
(function () {
  function hwc() {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  // Message-body reads (messenger.messages.getFull) kept in flight at once.
  // Indexing is I/O-bound on these backend round-trips, so we overlap many.
  const READ_CONCURRENCY = clamp(hwc() * 4, 16, 64);
  // Docs per /ingest request (the server's hard cap is its ingest.max_batch).
  const FLUSH_BATCH = 100;

  // ---- settings (ported from omnisearch, same storage keys/defaults) ----

  async function getExcludedAccounts() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      return new Set(s.excludedAccounts || []);
    } catch (e) {
      return new Set();
    }
  }

  async function getIncludeSpamTrash() {
    try {
      const r = await messenger.storage.local.get('settings');
      return !!(r.settings && r.settings.includeSpamTrash);
    } catch (e) {
      return false;
    }
  }

  // Whether to index the decrypted bodies of OpenPGP/S-MIME encrypted
  // messages. Default false — encrypted mail is indexed by header only, so no
  // decrypted plaintext is sent to the server.
  async function getIndexEncryptedBodies() {
    try {
      const r = await messenger.storage.local.get('settings');
      return !!(r.settings && r.settings.indexEncryptedBodies);
    } catch (e) {
      return false;
    }
  }

  async function getMaxBody() {
    try {
      const r = await messenger.storage.local.get('settings');
      const v = r.settings && r.settings.bodyLimit;
      return Number.isFinite(v) && v > 0 ? v : OmniExtract.DEFAULT_MAX_BODY;
    } catch (e) {
      return OmniExtract.DEFAULT_MAX_BODY;
    }
  }

  // ---- folders ----

  function isSpamOrTrash(folder) {
    if (!folder) return false;
    const t = folder.type;
    const su = folder.specialUse || [];
    return t === 'junk' || t === 'trash' || su.indexOf('junk') !== -1 || su.indexOf('trash') !== -1;
  }

  // Recursively flatten the folders of every included account, skipping
  // Junk/Trash (and their subfolders) unless the user opted them in.
  async function flattenFolders() {
    const excluded = await getExcludedAccounts();
    const includeSpamTrash = await getIncludeSpamTrash();
    const accounts = await messenger.accounts.list(true);
    const out = [];
    const walk = (folders) => {
      for (const f of folders || []) {
        if (!includeSpamTrash && isSpamOrTrash(f)) continue;
        out.push(f);
        walk(f.subFolders);
      }
    };
    for (const account of accounts) {
      if (excluded.has(account.id)) continue;
      walk(account.folders || (account.rootFolder && account.rootFolder.subFolders));
    }
    return out;
  }

  // account id -> display name, cached briefly (account names rarely change).
  let accountNamesCache = null;
  let accountNamesAt = 0;
  const ACCOUNT_NAMES_TTL = 10 * 60 * 1000;
  async function accountNameMap() {
    if (accountNamesCache && Date.now() - accountNamesAt < ACCOUNT_NAMES_TTL) {
      return accountNamesCache;
    }
    const accounts = (await messenger.accounts.list(false)) || [];
    const map = {};
    for (const a of accounts) {
      // Display name, else the identity's email (always present for mail
      // accounts), else the raw id.
      map[a.id] =
        a.name ||
        (a.identities && a.identities[0] && a.identities[0].email) ||
        a.id;
    }
    accountNamesCache = map;
    accountNamesAt = Date.now();
    return map;
  }

  function toMillis(date) {
    if (date instanceof Date) return date.getTime();
    const t = new Date(date).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // The already-resolved header fields a doc needs (body/preview come from
  // extraction). RFC Message-ID is stable across restarts, unlike the numeric
  // id, so it is the server-side identity (see dockey.js).
  function headerMeta(header, accountNames) {
    const folder = header.folder || {};
    const accountId = folder.accountId || '';
    return {
      id: String(header.id),
      headerMessageId: header.headerMessageId || '',
      subject: header.subject || '',
      from: header.author || '',
      to: (header.recipients || []).join(', '),
      date: toMillis(header.date),
      folderName: folder.name || '',
      accountId,
      accountName: accountNames[accountId] || accountId,
    };
  }

  // Turn an extracted OmniExtract doc into a server /ingest doc.
  function toServerDoc(doc) {
    return {
      message_id: doc.headerMessageId || 'local:' + doc.id,
      account_id: doc.accountId || '',
      account_name: doc.accountName || '',
      subject: doc.subject || '',
      from: doc.from || '',
      to: doc.to || '',
      date: doc.date ? new Date(doc.date).toISOString() : '',
      date_ms: doc.date || 0,
      folder: doc.folderName || '',
      body: doc.body || '',
      snippet: doc.preview || '',
      numeric_id: Number(doc.id) || null,
      header_only: !doc.bodyAvailable,
      encrypted: !!doc.encrypted,
      attachments: doc.attachments || [],
    };
  }

  // Build a server doc from one MessageHeader (single-message path, used by
  // the event listeners). The decrypt read happens here on the main thread —
  // decrypted plaintext is never sent to the extractor pool unless the user
  // opted in to indexing encrypted bodies.
  async function headerToDoc(header, indexEncrypted) {
    const accountNames = await accountNameMap();
    const meta = headerMeta(header, accountNames);
    const maxBody = await getMaxBody();
    let full;
    try {
      full = await messenger.messages.getFull(header.id, { decrypt: false });
    } catch (e) {
      return toServerDoc(OmniExtract.makeDoc(meta, '', false, false));
    }
    const r = OmniExtract.buildDoc(meta, full, indexEncrypted, maxBody);
    if (!r.needsDecrypt) return toServerDoc(r.doc);
    try {
      const dec = await messenger.messages.getFull(header.id); // decrypt defaults to true
      return toServerDoc(OmniExtract.buildDecryptedDoc(meta, dec, maxBody).doc);
    } catch (e) {
      return toServerDoc(OmniExtract.makeDoc(meta, '', false, true));
    }
  }

  // ---- iteration helpers ----

  async function forEachHeader(folderId, fn) {
    let page = await messenger.messages.list(folderId);
    for (const header of page.messages) await fn(header);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      for (const header of page.messages) await fn(header);
    }
  }

  async function totalMessageCount(folders) {
    let total = 0;
    for (const f of folders) {
      try {
        const info = await messenger.folders.getFolderInfo(f.id);
        total += (info && info.totalMessageCount) || 0;
      } catch (e) {
        total += f.messageCount || 0;
      }
    }
    return Math.max(total, 1);
  }

  async function* allHeaders(folders) {
    for (const folder of folders) {
      let page = await messenger.messages.list(folder.id);
      for (const header of page.messages) yield header;
      while (page.id) {
        page = await messenger.messages.continueList(page.id);
        for (const header of page.messages) yield header;
      }
    }
  }

  // Read one message body and turn it into a doc, using the extractor worker
  // pool for the CPU-heavy text extraction. The getFull I/O stays here
  // because messenger.* is main-thread-only.
  async function readDoc(header, accountNames, indexEncrypted, extractor, maxBody) {
    const meta = headerMeta(header, accountNames);
    let full;
    try {
      full = await messenger.messages.getFull(header.id, { decrypt: false });
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, false);
    }
    const r = await extractor.run('plain', meta, full, indexEncrypted, maxBody);
    if (!r.needsDecrypt) return r.doc;
    try {
      const dec = await messenger.messages.getFull(header.id); // decrypt
      return (await extractor.run('decrypted', meta, dec, false, maxBody)).doc;
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, true);
    }
  }

  // Full index build as a producer/consumer pipeline (see the header comment):
  // READ_CONCURRENCY workers pull headers, read bodies and extract text
  // concurrently, buffering finished docs and flushing them to the server in
  // batches. sink(docs) is awaited per batch, which applies natural
  // backpressure when the server (embedding) falls behind. onProgress drives
  // the UI bar. Resumable: a failure aborts the build, and the next build
  // skips already-indexed messages server-side (content-hash check).
  async function fullBuild(extractor, sink, onProgress) {
    const folders = await flattenFolders();
    const total = await totalMessageCount(folders);
    const indexEncrypted = await getIndexEncryptedBodies();
    const maxBody = await getMaxBody();
    const accountNames = await accountNameMap();

    let count = 0;
    let headerOnly = 0;
    let buffer = [];

    const headers = allHeaders(folders);
    // Serialise pulls from the shared async iterator (concurrent .next() is
    // unsafe); the real concurrency is in the per-header getFull/extract work.
    let pullChain = Promise.resolve({ done: true });
    function nextHeader() {
      pullChain = pullChain.then(() => headers.next());
      return pullChain.then((r) => (r.done ? null : r.value));
    }

    async function flush(force) {
      if (buffer.length === 0 || (!force && buffer.length < FLUSH_BATCH)) return;
      const batch = buffer.map(toServerDoc);
      buffer = [];
      await sink(batch);
      onProgress(Math.min(count / total, 0.99), count, headerOnly, total);
    }

    async function worker() {
      for (;;) {
        const header = await nextHeader();
        if (!header) break;
        const doc = await readDoc(header, accountNames, indexEncrypted, extractor, maxBody);
        if (!doc.bodyAvailable) headerOnly++;
        count++;
        buffer.push(doc);
        await flush(false);
      }
    }

    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    await flush(true);
    onProgress(1, count, headerOnly, total);
    return { count, headerOnly };
  }

  // Collect the live set for reconcile: every message currently visible in
  // every included folder, as docKey -> { account_id, message_id, folders,
  // headerId }. Keyed on the stable identity, not the numeric id (which
  // recycles every session — see dockey.js). Headers only, no body reads.
  // onProgress(processed, total), reported per folder, drives the UI during
  // the collection walk (total = summed folder message counts).
  async function collectAllIdentities(onProgress) {
    const folders = await flattenFolders();
    const total = onProgress ? await totalMessageCount(folders) : 0;
    let processed = 0;
    const live = new Map();
    for (const folder of folders) {
      await forEachHeader(folder.id, (header) => {
        const id = AIOSKey.serverIdentity(header);
        const key = id.account_id + AIOSKey.SEP + id.message_id;
        let entry = live.get(key);
        if (!entry) {
          entry = { account_id: id.account_id, message_id: id.message_id, folders: new Set(), headerId: header.id };
          live.set(key, entry);
        }
        if (folder.name) entry.folders.add(folder.name);
        processed++;
      });
      if (onProgress) onProgress(processed, total);
    }
    return live;
  }

  globalThis.AIOSReader = {
    flattenFolders,
    headerToDoc,
    fullBuild,
    collectAllIdentities,
    getExcludedAccounts,
    getIncludeSpamTrash,
    getIndexEncryptedBodies,
    isSpamOrTrash,
  };
})();
