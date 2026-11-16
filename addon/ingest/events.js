'use strict';
// Keeps the server's index correct as mail changes. Exposes globalThis.AIOSEvents.
//
// The push surface: all FIVE message events Thunderbird exposes
// (onNewMailReceived, onUpdated, onDeleted, onMoved, onCopied), each applied
// to the server as ingest / folder-remove / delete calls.
//
// Events alone cannot keep the index correct — onNewMailReceived fires when a
// message is *received*, which structurally cannot cover mail synced while
// Thunderbird was closed, mail filed server-side, or mail sent from another
// device. thunderbird-omnisearch measured that on a real profile (75% of one
// month's Archive mail missing, 81% of INBOX, 100% of Sent), and the same
// gap applies here.
//
// So freshness is a PULL, with events as the low-latency fast path on top:
// catchUp() re-walks everything newer than a stored watermark (with a 1-day
// overlap), and reconcile() diffs the server's index against the full live
// set. A dropped event costs latency instead of permanent invisibility.
(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Skew tolerance, not a rescan: mail can land a moment behind the mark, so
  // the catch-up window reaches slightly back.
  const DEFAULT_OVERLAP_MS = DAY_MS;
  const WATERMARK_KEY = 'aios_watermarks';

  function dateMs(value) {
    if (!value) return 0;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function headersOf(list) {
    return (list && list.messages) || [];
  }

  function identityOf(header) {
    return AIOSKey.serverIdentity(header);
  }

  function folderNameOf(header) {
    return (header.folder && header.folder.name) || '';
  }

  async function indexOpts() {
    return {
      excluded: await AIOSReader.getExcludedAccounts(),
      includeSpamTrash: await AIOSReader.getIncludeSpamTrash(),
      indexEncrypted: await AIOSReader.getIndexEncryptedBodies(),
    };
  }

  // Index one header now (single-message path, main thread). Skips excluded
  // accounts and Junk/Trash. Server-side dedup makes re-sends cheap.
  async function upsertHeader(header, opts) {
    const folder = header.folder;
    if (folder) {
      if (opts.excluded && opts.excluded.has(folder.accountId)) return false;
      if (!opts.includeSpamTrash && AIOSReader.isSpamOrTrash(folder)) return false;
    }
    const doc = await AIOSReader.headerToDoc(header, opts.indexEncrypted);
    await AIOSClient.ingest([doc]);
    return true;
  }

  // Wire up live incremental updates. Each listener is registered
  // independently so a single unsupported event API can't abort the others,
  // and each message is handled independently so one failure doesn't drop
  // the rest of a batch.
  function on(event, handler) {
    try {
      event.addListener(handler);
    } catch (e) {
      console.error('[AI OmniSearch] event listener registration failed:', e);
    }
  }

  function registerEvents() {
    const m = messenger.messages;

    on(m.onNewMailReceived, async (_folder, messageList) => {
      const opts = await indexOpts();
      for (const header of headersOf(messageList)) {
        try {
          await upsertHeader(header, opts);
        } catch (e) {
          console.error('[AI OmniSearch] onNewMailReceived update failed:', e);
        }
      }
    });

    on(m.onUpdated, async (message) => {
      const opts = await indexOpts();
      try {
        await upsertHeader(message, opts);
      } catch (e) {
        console.error('[AI OmniSearch] onUpdated update failed:', e);
      }
    });

    on(m.onDeleted, async (messageList) => {
      const items = headersOf(messageList).map(identityOf);
      if (!items.length) return;
      try {
        await AIOSClient.delete(items);
      } catch (e) {
        console.error('[AI OmniSearch] onDeleted update failed:', e);
      }
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      const opts = await indexOpts();
      // A message moved INTO Junk/Trash is dropped (upsertHeader skips it);
      // one moved out gets (re)indexed. Either way drop the originals'
      // folders first — the server merges folder lists, so removing the old
      // folder only deletes the record when the last folder goes.
      const removals = headersOf(originalMessages)
        .map((h) => ({ ...identityOf(h), folder: folderNameOf(h) }))
        .filter((r) => r.folder);
      if (removals.length) {
        try {
          await AIOSClient.removeFolder(removals);
        } catch (e) {
          console.error('[AI OmniSearch] onMoved folder-remove failed:', e);
        }
      }
      for (const header of headersOf(movedMessages)) {
        try {
          await upsertHeader(header, opts);
        } catch (e) {
          console.error('[AI OmniSearch] onMoved update failed:', e);
        }
      }
    });

    on(m.onCopied, async (_originalMessages, copiedMessages) => {
      const opts = await indexOpts();
      for (const header of headersOf(copiedMessages)) {
        try {
          await upsertHeader(header, opts);
        } catch (e) {
          console.error('[AI OmniSearch] onCopied update failed:', e);
        }
      }
    });
  }

  // ---- watermarks ----

  async function getWatermarks() {
    const r = await messenger.storage.local.get(WATERMARK_KEY);
    return (r && r[WATERMARK_KEY]) || {};
  }

  async function setWatermark(accountId, ms) {
    const w = await getWatermarks();
    w[accountId] = ms;
    await messenger.storage.local.set({ [WATERMARK_KEY]: w });
  }

  async function clearWatermarks() {
    await messenger.storage.local.remove(WATERMARK_KEY);
  }

  // ---- freshness ----

  // Index everything newer than each account's watermark. Cost is O(new
  // mail), not O(archive): messages.query bounds the work with fromDate.
  // The /has check skips messages the server already holds BEFORE paying
  // for their body reads (the 1-day overlap would otherwise re-read a day
  // of mail every run).
  async function catchUp(opts = {}) {
    const now = opts.now == null ? Date.now() : opts.now;
    const overlapMs = opts.overlapMs == null ? DEFAULT_OVERLAP_MS : opts.overlapMs;
    const indexOptions = await indexOpts();
    const accounts = (await messenger.accounts.list(false)) || [];
    let scanned = 0;
    let added = 0;

    for (const account of accounts) {
      if (indexOptions.excluded && indexOptions.excluded.has(account.id)) continue;
      const mark = (await getWatermarks())[account.id] || 0;
      let newest = mark;
      let list = await messenger.messages.query({
        accountId: account.id,
        fromDate: new Date(Math.max(0, mark - overlapMs)),
        includeSubFolders: true,
      });

      while (list) {
        const headers = headersOf(list);
        scanned += headers.length;

        // Ask the server before reading: one /has call per page instead of
        // a getFull body read per message.
        const known = new Set();
        if (headers.length) {
          try {
            const r = await AIOSClient.has(headers.map(identityOf));
            for (const k of r.known || []) {
              known.add(k.account_id + AIOSKey.SEP + k.message_id);
            }
          } catch (e) {
            console.error('[AI OmniSearch] /has check failed:', e);
          }
        }

        for (const header of headers) {
          const when = dateMs(header.date);
          if (when > newest) newest = when;
          const id = identityOf(header);
          if (known.has(id.account_id + AIOSKey.SEP + id.message_id)) continue;
          try {
            if (await upsertHeader(header, indexOptions)) added++;
          } catch (e) {
            console.error('[AI OmniSearch] catch-up ingest failed:', e);
          }
        }
        list = list.id ? await messenger.messages.continueList(list.id) : null;
      }

      // Advance even when nothing was found, so a quiet account does not
      // rescan the same window forever. Never past `now`: a future-dated
      // message must not push the mark ahead of real time and blind the
      // next run.
      await setWatermark(account.id, Math.min(Math.max(newest, mark), now));
    }

    return { scanned, added };
  }

  // Deep sweep: compare every live message against the server's index. The
  // server deletes orphans and fixes folder drift itself; the messages it
  // reports missing are re-read from Thunderbird and re-ingested. This is
  // the backstop for the one hole the watermark cannot see — back-dated mail
  // (an old Date header imported or moved in today) lands behind the mark
  // and is invisible to catchUp.
  async function reconcile() {
    const live = await AIOSReader.collectAllIdentities();
    const liveItems = [...live.values()].map((e) => ({
      account_id: e.account_id,
      message_id: e.message_id,
      folders: [...e.folders],
    }));
    const r = await AIOSClient.reconcile(liveItems);

    // Re-ingest what the server is missing. headerToDoc does a getFull body
    // read per message; AIOSClient serializes the writes.
    const opts = await indexOpts();
    let added = 0;
    for (const miss of r.missing || []) {
      const entry = live.get(miss.account_id + AIOSKey.SEP + miss.message_id);
      if (!entry || entry.headerId == null) continue;
      let header;
      try {
        header = await messenger.messages.get(Number(entry.headerId));
      } catch (e) {
        continue; // vanished mid-reconcile
      }
      if (!header) continue;
      try {
        if (await upsertHeader(header, opts)) {
          added++;
        }
      } catch (e) {
        console.error('[AI OmniSearch] reconcile re-ingest failed:', e);
      }
    }
    return {
      added,
      removed: r.deleted || 0,
      folders_updated: r.folders_updated || 0,
    };
  }

  globalThis.AIOSEvents = {
    registerEvents,
    catchUp,
    reconcile,
    clearWatermarks,
  };
})();
