'use strict';
// Keeps the index correct as mail changes. Exposes globalThis.AIOSEvents.
//
// The push surface: all FIVE message events Thunderbird exposes
// (onNewMailReceived, onUpdated, onDeleted, onMoved, onCopied), each applied
// to the index as ingest / folder-remove / delete calls.
//
// Events alone cannot keep the index correct — onNewMailReceived fires when a
// message is *received*, which structurally cannot cover mail synced while
// Thunderbird was closed, mail filed by a rule on the mail server, or mail sent
// from another device. thunderbird-omnisearch measured that on a real profile
// (75% of one month's Archive mail missing, 81% of INBOX, 100% of Sent), and the
// same gap applies here.
//
// So freshness is a PULL, with events as the low-latency fast path on top:
// catchUp() re-walks everything newer than a stored watermark (with a 1-day
// overlap), and reconcile() diffs the index against the full live
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
    return AIOSKey.identity(header);
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

  // Whether a header belongs in the index at all (excluded account, or
  // Junk/Trash the user did not opt in). Checked BEFORE any body read.
  function shouldIndex(header, opts) {
    const folder = header.folder;
    if (folder) {
      if (opts.excluded && opts.excluded.has(folder.accountId)) return false;
      if (!opts.includeSpamTrash && AIOSReader.isSpamOrTrash(folder)) return false;
    }
    return true;
  }

  // Index one header now (single-message path for live events). Index-side
  // dedup (content hash + deterministic point ids) makes re-sends cheap.
  async function upsertHeader(header, opts) {
    if (!shouldIndex(header, opts)) return false;
    const doc = await AIOSReader.headerToDoc(header, opts.indexEncrypted);
    await AIOSIndex.ingest([doc]);
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
        await AIOSIndex.deleteMessages(items);
      } catch (e) {
        console.error('[AI OmniSearch] onDeleted update failed:', e);
      }
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      const opts = await indexOpts();
      // A message moved INTO Junk/Trash is dropped (upsertHeader skips it);
      // one moved out gets (re)indexed. Either way drop the originals'
      // folders first — the index merges folder lists, so removing the old
      // folder only deletes the record when the last folder goes.
      const removals = headersOf(originalMessages)
        .map((h) => ({ ...identityOf(h), folder: folderNameOf(h) }))
        .filter((r) => r.folder);
      if (removals.length) {
        try {
          await AIOSIndex.removeFolder(removals);
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

  // Docs per ingest batch during catch-up and reconcile re-ingest. The
  // single-doc path (one embed call per message) made a large catch-up ~10x
  // slower than the batched rebuild pipeline.
  const INGEST_BATCH = 50;
  // Body reads (messenger.messages.getFull) kept in flight at once during
  // catch-up. Serial reads capped the walk at a few docs/sec; overlapping
  // them lifts the new-message rate by roughly this factor.
  const READ_CONCURRENCY = 8;
  // A window older than this is effectively the whole mailbox: size it from
  // folder counts (instant) instead of paginating every header — the
  // pagination takes minutes on a large mailbox with zero feedback, which
  // looks exactly like a hung indexer.
  const ESTIMATE_THRESHOLD_MS = 14 * DAY_MS;

  async function countWindow(account, fromDate) {
    // Cheap header-only pagination: how many messages the window covers, so
    // the progress percentage has a real denominator before any body read.
    let total = 0;
    let list = await messenger.messages.query({
      accountId: account.id,
      fromDate,
      includeSubFolders: true,
    });
    while (list) {
      total += headersOf(list).length;
      list = list.id ? await messenger.messages.continueList(list.id) : null;
    }
    return total;
  }

  async function folderTreeTotal(folders) {
    // Sum getFolderInfo counts over a folder tree — instant, unlike
    // paginating the headers. Includes Junk/Trash because messages.query
    // covers them too (shouldIndex filters per header later); the slight
    // overcount only makes the progress bar conservative.
    let total = 0;
    for (const f of folders || []) {
      try {
        const info = await messenger.folders.getFolderInfo(f.id);
        total += (info && info.totalMessageCount) || 0;
      } catch (e) {
        /* folder vanished — keep counting the rest */
      }
      total += await folderTreeTotal(f.subFolders);
    }
    return total;
  }

  // Run fn over items with at most `n` in flight; resolves in order of
  // completion. Workers never reject — fn's own try/catch handles its errors.
  async function mapPool(items, n, fn) {
    let next = 0;
    async function worker() {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  // Index everything newer than each account's watermark. Cost is O(new
  // mail), not O(archive): messages.query bounds the work with fromDate.
  // The known-set check skips messages the index already holds BEFORE paying
  // for their body reads (the 1-day overlap would otherwise re-read a day
  // of mail every run). Docs are ingested in batches, not one per request,
  // and body reads run READ_CONCURRENCY at a time.
  // onProgress(processed, total, headerOnly) drives the badge/UI; total is
  // the message count of the catch-up window across all accounts (folder
  // counts when the window is whole-mailbox sized — see ESTIMATE_THRESHOLD).
  async function catchUp(opts = {}, onProgress) {
    const now = opts.now == null ? Date.now() : opts.now;
    const overlapMs = opts.overlapMs == null ? DEFAULT_OVERLAP_MS : opts.overlapMs;
    const indexOptions = await indexOpts();
    const accounts = (await messenger.accounts.list(false)) || [];

    // Pass 1: size each account's window. Old/absent watermark (first run,
    // or pre-batching installs that never finished a full walk): the window
    // is the whole mailbox — estimate from folder counts, instantly. Recent
    // watermark: count the (small) window precisely.
    const accountsVerbose = await messenger.accounts.list(true);
    const windows = [];
    let grandTotal = 0;
    for (const account of accounts) {
      if (indexOptions.excluded && indexOptions.excluded.has(account.id)) continue;
      const mark = (await getWatermarks())[account.id] || 0;
      const fromDate = new Date(Math.max(0, mark - overlapMs));
      let total;
      try {
        if (now - mark > ESTIMATE_THRESHOLD_MS) {
          const verbose = accountsVerbose.find((a) => a.id === account.id);
          total = await folderTreeTotal(
            (verbose && verbose.folders) ||
              (verbose && verbose.rootFolder && verbose.rootFolder.subFolders)
          );
        } else {
          total = await countWindow(account, fromDate);
        }
      } catch (e) {
        // Sizing (query/folder info) failed — skip this account entirely
        // this run; its watermark is untouched, so the next run retries.
        console.error(
          '[AI OmniSearch] catch-up sizing failed for account %s — skipping it this run:',
          account.id, e
        );
        continue;
      }
      windows.push({ account, mark, fromDate, total });
      grandTotal += total;
    }

    let scanned = 0;
    let added = 0;
    let headerOnly = 0;
    let lastReport = -Infinity;
    const report = (force) => {
      if (!onProgress) return;
      if (!force && scanned - lastReport < 20) return;
      lastReport = scanned;
      onProgress(scanned, grandTotal, headerOnly);
    };
    report(true);

    // Pass 2: process each account's window with concurrent body reads and
    // batched ingest. The per-account walk (query/continueList) is the one
    // part not individually try/caught — an error there (list token expired,
    // account offline mid-walk) must kill ONLY this account's pass, not the
    // whole job: the watermark stays put and the next run retries it.
    for (const { account, mark, fromDate } of windows) {
      let newest = mark;
      let batch = [];
      let failedBatches = 0;
      let walkFailed = false;
      const flush = async (force) => {
        if (batch.length === 0 || (!force && batch.length < INGEST_BATCH)) return;
        const docs = batch;
        batch = [];
        try {
          await AIOSIndex.ingest(docs);
        } catch (e) {
          // The batch is lost for this run — but the watermark below is NOT
          // advanced when anything failed, so the next run re-walks this
          // window and /has quickly re-delivers only what is missing.
          failedBatches++;
          console.error('[AI OmniSearch] catch-up ingest failed:', e);
        }
      };

      try {
        let list = await messenger.messages.query({
          accountId: account.id,
          fromDate,
          includeSubFolders: true,
        });

        while (list) {
          const headers = headersOf(list);
          for (const header of headers) {
            const when = dateMs(header.date);
            if (when > newest) newest = when;
            scanned++;
          }

          // Ask the index before reading: one lookup per page instead of
          // a getFull body read per message.
          const known = new Set();
          if (headers.length) {
            try {
              const r = { known: await AIOSIndex.known(headers.map(identityOf)) };
              for (const k of r.known || []) {
                known.add(k.account_id + AIOSKey.SEP + k.message_id);
              }
            } catch (e) {
              console.error('[AI OmniSearch] /has check failed:', e);
            }
          }

          const todo = headers.filter(
            (header) =>
              !known.has(identityOf(header).account_id + AIOSKey.SEP + identityOf(header).message_id) &&
              shouldIndex(header, indexOptions)
          );
          if (todo.length) {
            await mapPool(todo, READ_CONCURRENCY, async (header) => {
              try {
                const doc = await AIOSReader.headerToDoc(header, indexOptions.indexEncrypted);
                if (doc.header_only) headerOnly++;
                batch.push(doc);
                added++;
                await flush(false);
              } catch (e) {
                console.error('[AI OmniSearch] catch-up read failed:', e);
              }
              report(false);
            });
          } else {
            report(false);
          }
          list = list.id ? await messenger.messages.continueList(list.id) : null;
        }
        await flush(true);
      } catch (e) {
        walkFailed = true;
        console.error(
          '[AI OmniSearch] catch-up walk failed for account %s at %d/%d — skipping to next account:',
          account.id, scanned, grandTotal, e
        );
        // Drop anything buffered from the dying account; the un-advanced
        // watermark re-delivers it next run.
        batch = [];
      }
      report(true);

      // Advance even when nothing was found, so a quiet account does not
      // rescan the same window forever — but ONLY when every batch made it
      // AND the walk completed: anything lost must stay behind the mark or
      // its messages silently disappear from the index until a reconcile.
      // Never past `now`: a future-dated message must not push the mark
      // ahead of real time and blind the next run.
      if (failedBatches === 0 && !walkFailed) {
        await setWatermark(account.id, Math.min(Math.max(newest, mark), now));
      } else {
        console.warn(
          '[AI OmniSearch] %d ingest batch(es) failed%s for %s — watermark left at %s so the next run retries them',
          failedBatches, walkFailed ? ' + walk aborted' : '', account.id,
          new Date(mark).toISOString()
        );
      }
    }

    return { scanned, added, headerOnly };
  }

  // After a completed full rebuild, everything up to the build's start time
  // is indexed — advance every included account's watermark to that moment
  // so the next catch-up is O(new mail) instead of another full walk. Never
  // called when the build failed (the throw skips it); the catch-up overlap
  // covers mail that arrived while the build ran.
  async function markAllCaughtUp(when) {
    const accounts = (await messenger.accounts.list(false)) || [];
    const excluded = await AIOSReader.getExcludedAccounts();
    for (const account of accounts) {
      if (excluded.has(account.id)) continue;
      await setWatermark(account.id, when);
    }
  }

  // Deep sweep: compare every live message against the index. The index
  // deletes orphans and fixes folder drift itself; the messages it reports
  // missing are re-read from Thunderbird and re-ingested. This is
  // the backstop for the one hole the watermark cannot see — back-dated mail
  // (an old Date header imported or moved in today) lands behind the mark
  // and is invisible to catchUp.
  //
  // Two progress stages, both reported through onProgress(processed, total,
  // headerOnly): the live-set collection, then the re-ingest of whatever
  // the index was missing (the total shrinks when the second stage starts).
  async function reconcile(onProgress) {
    const live = await AIOSReader.collectAllIdentities(
      onProgress ? (processed, total) => onProgress(processed, total, 0) : null
    );
    const liveItems = [...live.values()].map((e) => ({
      account_id: e.account_id,
      message_id: e.message_id,
      folders: [...e.folders],
    }));
    const r = await AIOSIndex.reconcile(liveItems);

    // Re-ingest what the index is missing, in batches. headerToDoc does a
    // getFull body read per message; AIOSIndex serializes the writes.
    const opts = await indexOpts();
    const missing = r.missing || [];
    let added = 0;
    let headerOnly = 0;
    let batch = [];
    let done = 0;
    const flush = async (force) => {
      if (batch.length === 0 || (!force && batch.length < INGEST_BATCH)) return;
      const docs = batch;
      batch = [];
      try {
        await AIOSIndex.ingest(docs);
      } catch (e) {
        // Lost for this run; reconcile makes no watermark promises, so the
        // next reconcile re-checks and re-delivers what is still missing.
        console.error('[AI OmniSearch] reconcile ingest failed:', e);
      }
    };
    for (const miss of missing) {
      const entry = live.get(miss.account_id + AIOSKey.SEP + miss.message_id);
      if (!entry || entry.headerId == null) {
        done++;
        continue;
      }
      let header;
      try {
        header = await messenger.messages.get(Number(entry.headerId));
      } catch (e) {
        done++;
        continue; // vanished mid-reconcile
      }
      if (header && shouldIndex(header, opts)) {
        try {
          const doc = await AIOSReader.headerToDoc(header, opts.indexEncrypted);
          if (doc.header_only) headerOnly++;
          batch.push(doc);
          added++;
          await flush(false);
        } catch (e) {
          console.error('[AI OmniSearch] reconcile re-ingest failed:', e);
        }
      }
      done++;
      if (onProgress && (done % 20 === 0 || done === missing.length)) {
        onProgress(done, missing.length, headerOnly);
      }
    }
    await flush(true);
    if (onProgress) onProgress(done, missing.length, headerOnly);
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
    markAllCaughtUp,
    clearWatermarks,
  };
})();
