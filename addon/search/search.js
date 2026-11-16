// Search page logic for the AI OmniSearch addon.
//
// Talks to the search server directly (/search with mode + filters) and to
// the background script (index status, rebuild/verify triggers) over runtime
// messages. Opening a result goes through AIOSOpen (ingest/open.js), which
// resolves the stable Message-ID to the live message before opening it.

let settings = null;
let pollInterval = null;

const MODE_LABEL = {
  hybrid: "Hybrid",
  semantic: "Semantic",
  keyword: "Keyword",
};

async function getSettings() {
  if (!settings) {
    const data = await messenger.storage.local.get("settings");
    settings = data.settings || {};
  }
  return settings;
}

async function saveSettings(patch) {
  const s = await getSettings();
  Object.assign(s, patch);
  await messenger.storage.local.set({ settings: s });
}

async function apiRequest(path, options = {}) {
  const s = await getSettings();
  const url = (s.serverUrl || "http://localhost:8342").replace(/\/+$/, "") + path;
  const headers = { "Content-Type": "application/json" };
  if (s.apiKey) {
    headers["X-API-Key"] = s.apiKey;
  }
  const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status}: ${body}`);
  }
  return resp.json();
}

// Ask the background script (it owns the pipeline state).
function bg(message) {
  return messenger.runtime.sendMessage(message);
}

// --- Search ---

async function currentMode() {
  const s = await getSettings();
  return s.mode || "hybrid";
}

async function doSearch() {
  const query = document.getElementById("search-input").value.trim();
  if (!query) return;

  const mode = await currentMode();
  const account = document.getElementById("account-filter").value || undefined;
  const from = document.getElementById("from-filter").value.trim() || undefined;
  const after = document.getElementById("after-filter").value || undefined;
  const before = document.getElementById("before-filter").value || undefined;
  const s = await getSettings();
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");

  statusEl.textContent = "Searching...";
  statusEl.className = "status searching";
  resultsEl.innerHTML = "";

  const startTime = performance.now();

  try {
    const body = {
      query,
      mode,
      limit: s.limit || 20,
    };
    if (account) body.account = account;
    if (from) body.from = from;
    if (after) body.after = after;
    if (before) body.before = before;

    const data = await apiRequest("/search", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const count = data.results.length;

    statusEl.textContent = statusLine(data, elapsed, count);
    statusEl.className =
      count === 0 ? "status empty" : data.mode_used !== data.mode ? "status" : "status success";

    for (const r of data.results) {
      resultsEl.appendChild(createResultCard(r, data.mode_used));
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.className = "status error";
  }
}

function statusLine(data, elapsed, count) {
  let line = `${MODE_LABEL[data.mode_used] || data.mode_used}: ${count} result${count !== 1 ? "s" : ""} in ${elapsed}s`;
  const sem = data.engines && data.engines.semantic;
  const kw = data.engines && data.engines.keyword;
  if (data.mode === "hybrid" && sem && kw) {
    line += ` (semantic ${sem.candidates}, keyword ${kw.candidates} candidates)`;
  }
  return line;
}

function scoreDisplay(result, modeUsed) {
  const parts = [];
  const sem = result.engines && result.engines.semantic;
  const kw = result.engines && result.engines.keyword;
  if (sem) parts.push(`sem #${sem.rank} (${(sem.score * 100).toFixed(0)}%)`);
  if (kw) parts.push(`kw #${kw.rank}`);
  if (parts.length) return parts.join(" · ");
  if (modeUsed === "semantic") return `${(result.score * 100).toFixed(0)}%`;
  return "";
}

function createResultCard(result, modeUsed) {
  const card = document.createElement("div");
  card.className = "result-card";
  card.addEventListener("click", () => openEmail(result));

  const score = scoreDisplay(result, modeUsed);
  const date = formatDate(result.date);
  const folders = Array.isArray(result.folders) ? result.folders.join(", ") : result.folder || "";
  const flags = [];
  if (result.header_only) flags.push('<span class="badge badge-flag" title="Body not downloaded when indexed — enable offline sync for that folder and rebuild.">header only</span>');
  if (result.encrypted) flags.push('<span class="badge badge-flag" title="Encrypted message — indexed by header only unless you opt in to indexing encrypted bodies.">encrypted</span>');

  card.innerHTML = `
    <div class="result-header">
      <span class="result-subject">${escapeHtml(result.subject || "(no subject)")}</span>
      <span class="result-score">${escapeHtml(score)}</span>
    </div>
    <div class="result-meta">
      <span class="result-from">${escapeHtml(result.from || "")}</span>
      <span class="result-date">${escapeHtml(date)}</span>
    </div>
    <div class="result-tags">
      <span class="badge badge-account">${escapeHtml(accountNameOf(result.account, result.account_name))}</span>
      <span class="badge badge-folder">${escapeHtml(folders)}</span>
      ${flags.join("")}
    </div>
    ${attachmentsHtml(result)}
    <div class="result-snippet">${escapeHtml(result.snippet || "")}</div>
  `;

  return card;
}

// Attachment names indexed for this message: the first few, then a "+N more"
// badge (the count only — hovering it lists the rest). Names are captured at
// index time; messages indexed before that was recorded show none until the
// next rebuild backfills them (no re-embedding involved).
const MAX_ATTACHMENT_BADGES = 3;

function attachmentsHtml(result) {
  const names = Array.isArray(result.attachments) ? result.attachments.filter(Boolean) : [];
  if (!names.length) return "";
  const shown = names.slice(0, MAX_ATTACHMENT_BADGES);
  const rest = names.slice(MAX_ATTACHMENT_BADGES);
  const badges = shown.map(
    (name) =>
      `<span class="badge badge-attachment" title="${escapeAttr(name)}">${escapeHtml(name)}</span>`
  );
  if (rest.length) {
    badges.push(
      `<span class="badge badge-attachment badge-more" title="${escapeAttr(rest.join(", "))}">+${rest.length} more</span>`
    );
  }
  const label = `${names.length} attachment${names.length === 1 ? "" : "s"}`;
  return `
    <div class="result-attachments" title="${escapeAttr(label)}">
      <span class="attach-icon" aria-hidden="true">📎</span>
      ${badges.join("")}
    </div>`;
}

async function openEmail(result) {
  const s = await getSettings();
  const ok = await AIOSOpen.openMessage(
    {
      headerMessageId: (result.message_id || "").replace(/^<|>$/g, ""),
      numeric_id: result.numeric_id != null ? Number(result.numeric_id) : null,
      account_id: result.account,
    },
    s.openIn || "tab"
  );
  if (!ok) {
    showToast("Email not found in Thunderbird. It may have been deleted or not synced yet.");
  }
}

// --- Date range presets ---
// A quick range writes into the same after/before inputs the search sends, so
// the dates stay visible and editable — no hidden second filter path. Server
// semantics: `after` is inclusive from local midnight, `before` is inclusive
// through the end of that day.

function ymd(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBack(n) {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
}

// value -> {after, before} as YYYY-MM-DD strings. "any" clears both;
// "custom" is absent on purpose: it leaves the dates the user typed alone.
const DATE_PRESETS = {
  any: () => ({ after: "", before: "" }),
  // "Last 7 days" includes today, so it starts 6 days back.
  "7d": () => ({ after: ymd(daysBack(6)), before: ymd(startOfToday()) }),
  "30d": () => ({ after: ymd(daysBack(29)), before: ymd(startOfToday()) }),
  "60d": () => ({ after: ymd(daysBack(59)), before: ymd(startOfToday()) }),
  week: () => {
    const monday = startOfToday();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return { after: ymd(monday), before: ymd(startOfToday()) };
  },
  month: () => {
    const today = startOfToday();
    return {
      after: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
      before: ymd(today),
    };
  },
  lastmonth: () => {
    const today = startOfToday();
    return {
      after: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      before: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  },
  year: () => {
    const today = startOfToday();
    return { after: ymd(new Date(today.getFullYear(), 0, 1)), before: ymd(today) };
  },
};

function applyDatePreset(name) {
  const preset = DATE_PRESETS[name];
  if (!preset) return false; // "custom": keep what is in the date inputs
  const { after, before } = preset();
  document.getElementById("after-filter").value = after;
  document.getElementById("before-filter").value = before;
  return true;
}

function markRangeCustom() {
  document.getElementById("range-preset").value = "custom";
}

function searchIfQuery() {
  if (document.getElementById("search-input").value.trim()) doSearch();
}

// --- Mode toggle ---

async function initModeToggle() {
  const toggle = document.getElementById("mode-toggle");
  const set = async (mode) => {
    await saveSettings({ mode });
    for (const btn of toggle.querySelectorAll(".mode-btn")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
  };
  await set(await currentMode());
  toggle.addEventListener("click", async (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    await set(btn.dataset.mode);
    const q = document.getElementById("search-input").value.trim();
    if (q) doSearch();
  });
}

// --- Account filter + name resolution (straight from Thunderbird, no server) ---

// accountId -> display name (account name, else identity email, else id).
// Results and stats carry the account_name captured at indexing time — which
// is '' for everything indexed before the extract.js accountName fix — so the
// page resolves names itself: it has the authoritative list right here.
const accountNames = new Map();

async function loadAccounts() {
  try {
    const accounts = (await messenger.accounts.list(false)) || [];
    for (const account of accounts) {
      accountNames.set(
        account.id,
        account.name ||
          (account.identities && account.identities[0] && account.identities[0].email) ||
          account.id
      );
    }
  } catch (e) {
    console.warn("Could not list accounts:", e);
  }
}

function accountNameOf(accountId, stored) {
  return accountNames.get(accountId) || stored || accountId || "";
}

async function loadAccountFilter() {
  const select = document.getElementById("account-filter");
  try {
    const accounts = (await messenger.accounts.list(false)) || [];
    for (const account of accounts) {
      const opt = document.createElement("option");
      opt.value = account.id;
      opt.textContent = accountNameOf(account.id, account.name);
      select.appendChild(opt);
    }
  } catch (e) {
    console.warn("Could not list accounts:", e);
  }
}

// --- Management Panel ---

async function loadHealth() {
  const el = document.getElementById("health-indicators");
  try {
    const data = await apiRequest("/health");
    const items = [
      ["Qdrant", data.qdrant],
      ["Ollama", data.ollama],
      ["SQLite", data.sqlite],
    ];
    el.innerHTML = items
      .map(([name, st]) => `<span class="health-dot ${st === "ok" ? "healthy" : "unhealthy"}"></span><span>${name}</span>`)
      .join("");
  } catch (e) {
    el.innerHTML = `<span class="health-dot unhealthy"></span><span>Server unreachable</span>`;
  }
}

async function loadStats() {
  const el = document.getElementById("management-stats");
  const cards = document.getElementById("account-cards");
  try {
    const stats = await apiRequest("/stats");
    el.innerHTML = `
      <div class="stat-chip">${stats.total_emails.toLocaleString()} indexed</div>
      ${stats.header_only ? `<div class="stat-chip warn">${stats.header_only.toLocaleString()} header-only</div>` : ""}
      ${stats.encrypted ? `<div class="stat-chip">${stats.encrypted.toLocaleString()} encrypted</div>` : ""}
      ${stats.qdrant_points != null ? `<div class="stat-chip">${stats.qdrant_points.toLocaleString()} vectors</div>` : ""}
    `;
    cards.innerHTML = "";
    for (const acct of stats.accounts || []) {
      const card = document.createElement("div");
      card.className = "account-card";
      card.innerHTML = `
        <div class="account-card-header">
          <span class="account-name">${escapeHtml(accountNameOf(acct.account_id, acct.name))}</span>
        </div>
        <div class="account-details">
          <span>${acct.count.toLocaleString()} messages indexed</span>
          ${acct.last_indexed_at ? `<span>Last indexed ${escapeHtml(formatDate(acct.last_indexed_at))}</span>` : ""}
        </div>
      `;
      cards.appendChild(card);
    }
  } catch (e) {
    el.innerHTML = `<div class="stat-chip warn">Could not load stats</div>`;
    cards.innerHTML = "";
  }
}

async function rebuild() {
  const r = await bg({ type: "rebuild" });
  if (!r || !r.started) {
    showToast((r && r.reason === "busy") ? "Another index job is already running" : "Could not start rebuild");
    return;
  }
  showToast("Rebuild started — mail already indexed is skipped");
  startPollingStatus();
}

async function verify() {
  const r = await bg({ type: "reconcile" });
  if (!r || !r.started) {
    showToast((r && r.reason === "busy") ? "Another index job is already running" : "Could not start verify");
    return;
  }
  showToast("Verify and repair started");
  startPollingStatus();
}

const PHASE_LABEL = {
  building: "Indexing",
  "catching-up": "Indexing",
  reconciling: "Verifying and repairing",
};

// The job (startedAt) whose management panel we auto-opened, so a running
// job opens the panel exactly once — the user can still close it.
let autoOpenedFor = null;

// Progress line parts: counts + header-only flags, and pace + ETA. The rate
// only kicks in after a few seconds so it is not wild at the start of a job.
function progressParts(status) {
  const label = PHASE_LABEL[status.phase] || status.phase;
  const pct =
    status.total > 0
      ? Math.min(100, Math.round((status.processed / status.total) * 100))
      : null;
  const counts =
    status.total > 0
      ? `${status.processed.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`
      : `${status.processed.toLocaleString()} processed`;
  const flags = status.headerOnly
    ? `${status.headerOnly.toLocaleString()} header-only`
    : "";
  const headline = [label, counts, flags].filter(Boolean).join(" · ");

  let pace = "";
  const elapsedMs = status.startedAt ? Date.now() - status.startedAt : 0;
  if (status.processed > 0 && elapsedMs > 5000) {
    const rate = Math.round((status.processed / elapsedMs) * 60000);
    if (rate > 0) {
      pace = `${rate.toLocaleString()} msgs/min`;
      if (status.total > status.processed) {
        const etaMin = Math.round((status.total - status.processed) / rate);
        pace +=
          etaMin >= 60
            ? ` · ~${Math.floor(etaMin / 60)}h ${etaMin % 60}m left`
            : ` · ~${etaMin}m left`;
      }
    }
  }
  return { headline, pace };
}

async function pollStatusOnce() {
  try {
    const status = await bg({ type: "getStatus" });
    if (!status) return;
    if (status.running || status.phase !== "idle") {
      // A job is running — keep polling even if it was started in the
      // background (startup/daily catch-up), so the popover progress line
      // and completion toast actually update.
      startPollingStatus();
      const progressEl = document.getElementById("indexer-progress");
      progressEl.classList.remove("hidden");
      document.getElementById("job-error").classList.add("hidden");
      // Auto-open the management panel once per job so the bar is visible
      // without hunting for the toggle (the user can still close it).
      if (autoOpenedFor !== status.startedAt) {
        autoOpenedFor = status.startedAt;
        document.getElementById("management-panel").classList.remove("hidden");
      }
      const { headline, pace } = progressParts(status);
      document.getElementById("progress-label").textContent = headline;
      document.getElementById("progress-sub").textContent = pace;
      const pct = status.total > 0 ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
      document.getElementById("progress-fill").style.width = pct + "%";
    } else {
      stopPollingStatus();
      const errEl = document.getElementById("job-error");
      if (status.lastError) {
        // Persistent banner (the toast auto-hides) — hover the toolbar
        // badge for the same text.
        errEl.textContent = `Last job failed: ${status.lastError}`;
        errEl.classList.remove("hidden");
        showToast(`Last job failed: ${status.lastError}`);
      } else {
        errEl.classList.add("hidden");
        if (status.lastResult) showToast(jobSummary(status.lastResult));
      }
      loadStats();
      loadHealth();
    }
  } catch (e) {
    stopPollingStatus();
  }
}

function jobSummary(result) {
  if (result == null) return "";
  if (result.count != null) {
    return `Indexed ${result.count.toLocaleString()} messages` +
      (result.headerOnly ? ` (${result.headerOnly.toLocaleString()} header-only)` : "") +
      (result.failed ? ` · ${result.failed.toLocaleString()} skipped, see the server log` : "");
  }
  if (result.scanned != null) {
    return `Catch-up: scanned ${result.scanned.toLocaleString()}, indexed ${result.added.toLocaleString()}`;
  }
  if (result.removed != null) {
    return `Repaired: +${result.added} indexed, ${result.removed} removed, ${result.folders_updated} folder fixes`;
  }
  return "Done";
}

function startPollingStatus() {
  if (pollInterval) return;
  pollStatusOnce();
  pollInterval = setInterval(pollStatusOnce, 2000);
}

function stopPollingStatus() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  document.getElementById("indexer-progress").classList.add("hidden");
}

// --- Version ---

async function loadVersion() {
  const el = document.getElementById("version-info");
  if (!el) return;
  const clientVersion = messenger.runtime.getManifest().version;
  el.textContent = `addon v${clientVersion}`;
  el.classList.remove("mismatch");
  el.title = `Addon v${clientVersion}`;
  try {
    const data = await apiRequest("/version");
    const serverVersion = data.version || "unknown";
    if (serverVersion === clientVersion) {
      el.textContent = `v${clientVersion}`;
      el.title = `Addon v${clientVersion} · Server v${serverVersion}`;
    } else {
      el.textContent = `addon v${clientVersion} · server v${serverVersion}`;
      el.classList.add("mismatch");
      el.title = `Version mismatch — addon v${clientVersion} vs server v${serverVersion}. Please update both to match.`;
    }
  } catch (e) {
    el.textContent = `addon v${clientVersion} · server unreachable`;
    el.title = `Could not fetch server version: ${e.message}`;
  }
}

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// escapeHtml leaves quotes alone, which breaks out of an attribute value
// (an attachment name with a `"` in it, say).
function escapeAttr(text) {
  return escapeHtml(String(text == null ? "" : text))
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoDate;
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 5000);
}

// --- Init ---

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("search-btn").addEventListener("click", doSearch);
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  document.getElementById("from-filter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  document.getElementById("account-filter").addEventListener("change", () => {
    if (document.getElementById("search-input").value.trim()) doSearch();
  });
  document.getElementById("range-preset").addEventListener("change", (e) => {
    const applied = applyDatePreset(e.target.value);
    if (!applied) {
      // "Custom range": leave the dates as they are and let the user edit them.
      document.getElementById("after-filter").focus();
      return;
    }
    searchIfQuery();
  });
  document.getElementById("after-filter").addEventListener("change", () => {
    markRangeCustom();
    searchIfQuery();
  });
  document.getElementById("before-filter").addEventListener("change", () => {
    markRangeCustom();
    searchIfQuery();
  });

  document.getElementById("open-settings").addEventListener("click", () => {
    messenger.runtime.openOptionsPage();
  });

  document.getElementById("toggle-management").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("management-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      loadHealth();
      loadStats();
      pollStatusOnce();
    }
  });

  // Popover behaviour: a click outside the panel (or Escape) closes it.
  document.addEventListener("click", (e) => {
    const panel = document.getElementById("management-panel");
    if (panel.classList.contains("hidden")) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest("#toggle-management")) return;
    panel.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.getElementById("management-panel").classList.add("hidden");
    }
  });

  document.getElementById("rebuild-btn").addEventListener("click", rebuild);
  document.getElementById("verify-btn").addEventListener("click", verify);

  await initModeToggle();
  await loadAccounts();
  await loadAccountFilter();
  loadVersion();

  // If the background is mid-job when the page opens, pick up its progress.
  pollStatusOnce();

  // If opened from the popup with ?q=..., pre-fill and run the search.
  const params = new URLSearchParams(window.location.search);
  const initialQuery = params.get("q");
  if (initialQuery) {
    document.getElementById("search-input").value = initialQuery;
    doSearch();
  }
});
