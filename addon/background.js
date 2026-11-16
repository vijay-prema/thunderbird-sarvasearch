'use strict';
// Orchestrator. Drives the ingestion pipeline (mail reads via AIOSReader,
// extraction in the worker pool, uploads via AIOSClient), keeps the server
// fresh via AIOSEvents (live events + daily catch-up), and answers the UI
// pages over runtime messages.
//
// The worker-pool RPC is ported from CR0CKER/thunderbird-omnisearch (MIT) —
// its background.js — with its engine worker replaced by the search server.
// Depends on the globals AIOSKey, OmniExtract, AIOSClient, AIOSReader,
// AIOSOpen, AIOSEvents (load order is set in manifest.json).
(function () {
  const SEARCH_URL = 'search/search.html';
  const SPACE_NAME = 'ai_omnisearch';
  const ALARM = 'aios-catchup';
  const ALARM_PERIOD_MIN = 1440; // daily

  const DEFAULT_SETTINGS = {
    serverUrl: 'http://localhost:8342',
    apiKey: '',
    limit: 20,
    openIn: 'tab',
    mode: 'hybrid',
    includeSpamTrash: false,
    indexEncryptedBodies: false,
    bodyLimit: 4000,
    excludedAccounts: [],
  };

  // ---- Worker RPC (ported from omnisearch) ----
  // Shared request/response envelope: post {reqId, ...payload}, resolve when
  // the worker echoes {reqId, ok, result|error} back.
  function rpcWorker(url) {
    const w = new Worker(url);
    const pending = new Map();
    let nextReqId = 1;
    w.onmessage = (e) => {
      const { reqId, ok, result, error } = e.data;
      const resolver = pending.get(reqId);
      if (!resolver) return;
      pending.delete(reqId);
      if (ok) resolver.resolve(result);
      else resolver.reject(new Error(error));
    };
    w.onerror = (e) => console.error('[AI OmniSearch] worker error:', e.message || e);
    return function post(payload) {
      const reqId = nextReqId++;
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        w.postMessage({ reqId, ...payload });
      });
    };
  }

  // Pool of extractor workers for the CPU-heavy text extraction during a
  // rebuild — sized to the machine, so HTML stripping runs across cores.
  // Calls are round-robined; each worker queues its own requests.
  const EXTRACT_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const extractPosts = Array.from({ length: EXTRACT_WORKERS }, () =>
    rpcWorker('ingest/extract.worker.js')
  );
  let extractRR = 0;
  const extractor = {
    run(mode, headerMeta, full, indexEncrypted, maxBody) {
      const post = extractPosts[extractRR++ % extractPosts.length];
      return post({ mode, headerMeta, full, indexEncrypted, maxBody });
    },
  };

  // ---- Status (mirrored to storage so UI pages can poll it) ----
  const status = {
    phase: 'idle', // idle | building | catching-up | reconciling
    running: false,
    processed: 0,
    total: 0,
    headerOnly: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    lastResult: null,
  };
  let statusTimer = null;

  function persistStatusSoon() {
    if (statusTimer) return;
    statusTimer = setTimeout(async () => {
      statusTimer = null;
      try {
        await messenger.storage.local.set({ indexerStatus: { ...status } });
      } catch (e) {
        /* storage full/unavailable — UI reads the live value too */
      }
    }, 500);
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    persistStatusSoon();
  }

  // ---- Jobs ----

  async function runJob(phase, fn) {
    if (status.running) return { started: false, reason: 'busy' };
    status.running = true;
    setStatus({
      phase,
      processed: 0,
      total: 0,
      headerOnly: 0,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    });
    try {
      const result = await fn();
      setStatus({ phase: 'idle', finishedAt: Date.now(), lastResult: result });
      return { started: true, result };
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error(`[AI OmniSearch] ${phase} failed:`, msg);
      setStatus({ phase: 'idle', finishedAt: Date.now(), lastError: msg });
      return { started: true, error: msg };
    } finally {
      status.running = false;
    }
  }

  // Full rebuild: walk every included folder, push every message. Cheap to
  // re-run after a failure — the server skips unchanged messages by content
  // hash, so a rebuild resumes where it stopped.
  function fullBuild() {
    return runJob('building', async () => {
      const sink = async (docs) => {
        await AIOSClient.ingest(docs);
      };
      return AIOSReader.fullBuild(extractor, sink, (frac, count, headerOnly, total) => {
        setStatus({ processed: count, total, headerOnly });
      });
    });
  }

  function catchUp() {
    return runJob('catching-up', () => AIOSEvents.catchUp());
  }

  function reconcileNow() {
    return runJob('reconciling', () => AIOSEvents.reconcile());
  }

  async function clearIndex() {
    await AIOSClient.clear();
    await AIOSEvents.clearWatermarks();
    setStatus({ lastError: null, lastResult: { cleared: true }, finishedAt: Date.now() });
    return { cleared: true };
  }

  // ---- UI message router ----

  messenger.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'getStatus':
        return Promise.resolve({ ...status });
      case 'rebuild':
        return fullBuild();
      case 'catchup':
        return catchUp();
      case 'reconcile':
        return reconcileNow();
      case 'clear':
        return clearIndex();
      default:
        return undefined;
    }
  });

  // ---- Live updates, alarms, first run ----

  AIOSEvents.registerEvents();

  async function ensureAlarm() {
    try {
      await messenger.alarms.clear(ALARM);
      await messenger.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MIN });
    } catch (e) {
      console.error('[AI OmniSearch] alarm setup failed:', e);
    }
  }

  messenger.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) catchUp();
  });

  // Spaces toolbar entry, reachable from every Thunderbird space (from the
  // upstream thunderbird-ai-search addon).
  async function ensureSpaceRegistered() {
    if (!messenger.spaces || !messenger.spaces.create) return;
    try {
      await messenger.spaces.create(SPACE_NAME, SEARCH_URL, {
        title: 'AI OmniSearch',
        defaultIcons: {
          16: 'icons/search-16.svg',
          32: 'icons/search-32.svg',
        },
      });
    } catch (e) {
      // Already registered from a previous load — ignore.
    }
  }

  async function ensureDefaultSettings() {
    const data = await messenger.storage.local.get('settings');
    const existing = data.settings || {};
    await messenger.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...existing } });
  }

  // First run (or a fresh server): a full build; otherwise just catch up.
  // If the server is unreachable, do nothing — the user will see it in the
  // search page and can hit Rebuild once it is up.
  async function firstRun() {
    try {
      const stats = await AIOSClient.stats();
      if (!stats || !stats.total_emails) {
        fullBuild();
      } else {
        catchUp();
      }
    } catch (e) {
      console.warn('[AI OmniSearch] server unreachable on startup:', e);
    }
  }

  messenger.runtime.onInstalled.addListener(async (details) => {
    await ensureDefaultSettings();
    await ensureSpaceRegistered();
    await ensureAlarm();
    if (details && (details.reason === 'install' || details.reason === 'update')) {
      firstRun();
    }
  });

  messenger.runtime.onStartup.addListener(async () => {
    await ensureSpaceRegistered();
    await ensureAlarm();
    catchUp();
  });

  ensureSpaceRegistered();
})();
