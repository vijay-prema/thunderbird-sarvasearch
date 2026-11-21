// Search page logic for the SarvaSearch addon.
//
// Runs the search itself (SarvaSearch -> Qdrant, with Ollama embedding the
// query) and asks the background script only for index status and job
// triggers. Opening a result goes through SarvaOpen (ingest/open.js), which
// resolves the stable Message-ID to the live message before opening it.

let pollInterval = null;

const MODE_LABEL = {
  hybrid: "Hybrid",
  semantic: "Semantic",
  keyword: "Keyword",
};

// The message-type combobox is one choice at a time, so each position sets at
// most one of the two filters the search understands. The library keeps them
// separate (the CLI can ask for both); the combobox deliberately does not
// combine them, because a picker that silently keeps a filter from an earlier
// choice is worse than one that replaces it.
const MAIL_TYPE_FILTERS = {
  only: { notifications: "only" },
  exclude: { notifications: "exclude" },
  attachments: { attachments: "only" },
};

// Settings live in lib/settings.js; these are the only two accessors the page
// needs, kept as thin wrappers so the rest of the file reads unchanged.
function getSettings() {
  return SarvaSettings.get();
}

function saveSettings(patch) {
  return SarvaSettings.save(patch);
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
  // '' is "Any message type"; the other positions are the notification modes
  // and the attachment filter (see MAIL_TYPE_FILTERS).
  const mailType = MAIL_TYPE_FILTERS[document.getElementById("notify-filter").value] || {};
  const after = document.getElementById("after-filter").value || undefined;
  const before = document.getElementById("before-filter").value || undefined;
  // "Latest" lives in the same combobox but is a ranking choice, not a window:
  // it leaves the dates empty and asks the fusion for a newest-first list.
  const latest = document.getElementById("range-preset").value === "latest";
  const s = await getSettings();
  const statusEl = document.getElementById("status");
  const resultsEl = document.getElementById("results");

  statusEl.textContent = "Searching...";
  statusEl.className = "status searching";
  resultsEl.innerHTML = "";

  const startTime = performance.now();

  try {
    const data = await SarvaSearch.search({
      query,
      mode,
      limit: s.limit || 20,
      account,
      from,
      after,
      before,
      latest,
      notifications: mailType.notifications,
      attachments: mailType.attachments,
      settings: s,
    });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    const count = data.results.length;

    statusEl.textContent = statusLine(data, elapsed, count);
    statusEl.className =
      count === 0 ? "status empty" : data.mode_used !== data.mode ? "status" : "status success";

    // Colours are resolved per search, not once per page: the options page can
    // change one in another tab between two searches.
    await refreshAccountColors();

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
  if (data.latest) line += " · newest first";
  if (data.notifications === "only") line += " · notifications only";
  else if (data.notifications === "exclude") line += " · notifications hidden";
  if (data.attachments === "only") line += " · with attachments";
  else if (data.attachments === "exclude") line += " · without attachments";
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
  card.addEventListener("click", () => {
    if (endsSelection(card)) return;
    openEmail(result);
  });

  const score = scoreDisplay(result, modeUsed);
  const date = formatDate(result.date);
  const folders = Array.isArray(result.folders) ? result.folders.join(", ") : result.folder || "";
  const account = SarvaAccountColors.colorFor(result.account);
  const accountName = accountNameOf(result.account, result.account_name);
  // The left edge and the badge dot carry the colour; the badge background only
  // tints, so the name stays readable whatever the colour is.
  card.style.setProperty("--account-color", account.color);
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
      <span class="badge badge-account" style="background: ${account.color}22; border-color: ${account.color}" title="${escapeAttr(`${accountName} — ${account.label}`)}"><span class="account-dot" style="background: ${account.color}" aria-hidden="true"></span>${escapeHtml(accountName)}</span>
      <span class="badge badge-folder">${escapeHtml(folders)}</span>
      ${flags.join("")}
    </div>
  `;

  const attachments = attachmentsNode(result);
  if (attachments) card.appendChild(attachments);
  card.appendChild(snippetNode(result.snippet, result));

  return card;
}

// --- Selecting text vs opening something ---

// A click that lands with a live selection inside `el` is the end of a
// selection gesture — it must not open anything. The selection itself is the
// signal. A pointer-distance test used to run alongside it, and it was wrong in
// the way that matters: an ordinary click that drifted a few pixels (a trackpad
// click, a hand that moved between press and release) was silently treated as a
// drag, so the link, the chip and the card all did nothing and said nothing.
// The check is scoped to `el` so a selection in another card never blocks this
// one, and an ignored click is logged rather than vanishing.
function endsSelection(el) {
  if (!selectionInside(el)) return false;
  console.info("[SarvaSearch] click ignored: a text selection covers this element");
  return true;
}

function selectionInside(el) {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || !String(sel).trim()) return false;
  try {
    return sel.containsNode ? sel.containsNode(el, true) : false;
  } catch (e) {
    return false;
  }
}

// --- Snippet preview ---

// A body preview with a URL in it should be one click from the browser. Only
// http(s) (and a bare "www.") becomes a link — any other scheme is a click that
// does something the user did not ask for.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function snippetNode(text, result) {
  const el = document.createElement("div");
  el.className = "result-snippet";
  const value = String(text == null ? "" : text);
  let at = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    const url = SarvaText.trimUrlTail(match[0]);
    if (!url.replace(/^https?:\/\//i, "").replace(/^www\./i, "")) continue;
    if (match.index > at) el.appendChild(document.createTextNode(value.slice(at, match.index)));
    // The stored snippet is the body's first N characters, so a URL running to
    // its end may be half an address. Only punctuation after it counts as
    // "followed by prose", which means the URL really ended.
    const after = match[0].slice(url.length);
    const cut = match.index + match[0].length === value.length && /^[.,;:!?'"”’)\]}]*$/.test(after);
    el.appendChild(linkNode(url, result, cut, match.index));
    at = match.index + url.length;
  }
  if (at < value.length) el.appendChild(document.createTextNode(value.slice(at)));
  return el;
}

function hrefFor(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function linkNode(url, result, cut, offset) {
  const a = document.createElement("a");
  a.className = cut ? "snippet-link snippet-link-cut" : "snippet-link";
  a.dataset.url = url; // what the preview showed — possibly a prefix
  a.dataset.offset = String(offset == null ? "" : offset);
  a.href = hrefFor(url);
  a.textContent = url;
  a.title = cut
    ? `Open in your browser (the preview may cut this address short): ${hrefFor(url)}`
    : `Open in your browser: ${hrefFor(url)}`;
  // The card under the link opens the message: stop the click there, in every
  // button, or a link opens a message and a browser tab.
  const open = () => {
    // Dragging across the address is a selection, not a click on the link.
    if (endsSelection(a.closest(".result-card") || a)) return;
    resolveAndOpen(a, result);
  };
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  a.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  // Hover is intent: complete the address before the click, so a truncated URL
  // opens the right page with no wait.
  if (cut) a.addEventListener("mouseenter", () => resolveLink(a, result));
  return a;
}

// Payload bodies, by message. Hovering and then clicking must not re-fetch one,
// and a search page never holds more than a handful of cards.
const bodyCache = new Map();
const pendingLinks = new WeakMap();

async function bodyOf(result) {
  const account = String(result.account || "");
  const messageId = String(result.message_id || "");
  const key = `${account}\u0000${messageId}`;
  const cached = bodyCache.get(key);
  if (cached) return cached;
  const fetching = (async () => {
    // Same derivation lib/search.js uses: the point id is uuid5(account|id).
    const pointId = await SarvaText.pointId(account, messageId);
    const points = await SarvaQdrant.retrieve([pointId]);
    return (points && points[0] && points[0].payload && points[0].payload.body) || "";
  })();
  bodyCache.set(key, fetching);
  if (bodyCache.size > 50) bodyCache.delete(bodyCache.keys().next().value);
  return fetching;
}

// The anchor's URL as the preview showed it, replaced by the whole address the
// stored body carries. A failed lookup leaves it alone and lets a later click
// try again.
function resolveLink(a, result) {
  const shown = a.dataset.url || "";
  if (!a.classList.contains("snippet-link-cut")) return Promise.resolve(hrefFor(shown));
  const pending = pendingLinks.get(a);
  if (pending) return pending;

  const work = (async () => {
    let full = shown;
    try {
      const offset = Number.parseInt(a.dataset.offset, 10);
      full = SarvaText.extendUrl(await bodyOf(result), shown, Number.isNaN(offset) ? undefined : offset) || shown;
    } catch (e) {
      // The index is unreachable or the body is gone: open the prefix, as before.
      pendingLinks.delete(a);
      return hrefFor(shown);
    }
    if (full !== shown) {
      // We know the whole address now: show it, so the card stops looking cut.
      a.dataset.url = full;
      a.textContent = full;
      a.href = hrefFor(full);
      a.title = `Open in your browser: ${hrefFor(full)}`;
      a.classList.remove("snippet-link-cut");
    }
    return hrefFor(full);
  })();
  pendingLinks.set(a, work);
  return work;
}

// A click must never hang on a slow index: after a moment it opens what it has,
// and the repair still lands on the card when it arrives.
const RESOLVE_TIMEOUT_MS = 1200;

async function resolveAndOpen(a, result) {
  a.classList.add("busy");
  let href = hrefFor(a.dataset.url || "");
  try {
    const resolved = await Promise.race([
      resolveLink(a, result),
      new Promise((r) => setTimeout(() => r(null), RESOLVE_TIMEOUT_MS)),
    ]);
    if (resolved) href = resolved;
  } finally {
    a.classList.remove("busy");
    openInBrowser(href);
  }
}

// Opening a link must never fail silently: a swallowed error here is
// indistinguishable from a dead control, and that is exactly how this read when
// it broke. `openDefaultBrowser` is synchronous inside Thunderbird (it hands the
// URL to the OS), so a rejection has to be caught on the promise it may return,
// and a missing API is reported rather than replaced with a window.open() that
// fires after an await — no user gesture is left by then, so the popup is
// blocked without a word.
function openInBrowser(url) {
  const open = messenger.windows && messenger.windows.openDefaultBrowser;
  if (typeof open !== "function") {
    console.error("[SarvaSearch] messenger.windows.openDefaultBrowser is unavailable");
    showToast(`Could not open ${url} — this Thunderbird has no openDefaultBrowser API.`);
    return;
  }
  try {
    const opening = open.call(messenger.windows, url);
    if (opening && typeof opening.catch === "function") {
      opening.catch((e) => {
        console.error("[SarvaSearch] openDefaultBrowser failed:", e);
        showToast(`Could not open the link in your browser: ${(e && e.message) || e}`);
      });
    }
  } catch (e) {
    console.error("[SarvaSearch] openDefaultBrowser threw:", e);
    showToast(`Could not open the link in your browser: ${e.message || e}`);
  }
}

async function refreshAccountColors() {
  try {
    await SarvaAccountColors.load();
  } catch (e) {
    // A colour is decoration: never fail a search over one.
  }
}

// Attachment names indexed for this message: the first few, then a "+N more"
// badge (the count only — hovering it lists the rest). Names are captured at
// index time; messages indexed before that was recorded show none until the
// next rebuild backfills them (no re-embedding involved).
//
// Each chip opens that attachment and nothing else — the whole point of the
// chip, given the card it sits in opens the email.
const MAX_ATTACHMENT_BADGES = 3;

function attachmentsNode(result) {
  const names = Array.isArray(result.attachments) ? result.attachments.filter(Boolean) : [];
  if (!names.length) return null;

  const row = document.createElement("div");
  row.className = "result-attachments";
  row.title = `${names.length} attachment${names.length === 1 ? "" : "s"}`;

  const icon = document.createElement("span");
  icon.className = "attach-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📎";
  row.appendChild(icon);

  const shown = names.slice(0, MAX_ATTACHMENT_BADGES);
  const rest = names.slice(MAX_ATTACHMENT_BADGES);
  shown.forEach((name, index) => {
    const chip = document.createElement("span");
    chip.className = "badge badge-attachment";
    chip.textContent = name;
    chip.title = `Open ${name}`;
    chip.addEventListener("click", (e) => {
      // Not the card: opening the message instead of the attachment is exactly
      // what this control exists to avoid. A drag across the name is a
      // selection, though, and must not open the attachment either.
      e.preventDefault();
      e.stopPropagation();
      if (endsSelection(chip)) return;
      openAttachment(result, name, index, chip);
    });
    row.appendChild(chip);
  });
  if (rest.length) {
    const more = document.createElement("span");
    more.className = "badge badge-attachment badge-more";
    more.textContent = `+${rest.length} more`;
    more.title = rest.join(", ");
    // A count, not a target — but a click on it must not open the message either.
    more.addEventListener("click", (e) => e.stopPropagation());
    row.appendChild(more);
  }
  return row;
}

// Thunderbird's own opener can stall — a save dialog waiting behind the window,
// or an API that never answers — and a stalled call used to hold the chip in
// "pending" for the life of the page, so every later click on it was silently
// dropped. Bound it, report it, and always release the chip.
const ATTACH_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function openAttachment(result, name, index, chip) {
  if (chip.classList.contains("pending")) return;
  chip.classList.add("pending");
  try {
    const outcome = await withTimeout(
      SarvaAttach.open(
        {
          headerMessageId: (result.message_id || "").replace(/^<|>$/g, ""),
          numeric_id: result.numeric_id != null ? Number(result.numeric_id) : null,
          account_id: result.account,
        },
        { name, index }
      ),
      ATTACH_TIMEOUT_MS,
      { ok: false, reason: "timeout" }
    );
    if (outcome.ok) return;
    console.error("[SarvaSearch] could not open attachment", name, outcome.reason, outcome.error || "");
    showToast(attachmentError(name, outcome));
  } catch (e) {
    console.error("[SarvaSearch] opening the attachment threw:", e);
    showToast(`Could not open “${name}”: ${e.message}`);
  } finally {
    chip.classList.remove("pending");
  }
}

function attachmentError(name, outcome) {
  if (outcome.reason === "message-not-found") {
    return "Email not found in Thunderbird. It may have been deleted or not synced yet.";
  }
  if (outcome.reason === "attachment-missing") {
    return `“${name}” is no longer attached to this message — open the email to see what is.`;
  }
  if (outcome.reason === "timeout") {
    return `Thunderbird did not answer when opening “${name}” — try again, or open the email and click the attachment there.`;
  }
  return `Could not open “${name}”: ${outcome.error || outcome.reason}`;
}

async function openEmail(result) {
  const s = await getSettings();
  const ok = await SarvaOpen.openMessage(
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
// the dates stay visible and editable — no hidden second filter path.
// `after` is inclusive from local midnight, `before` is inclusive through the
// end of that day.

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
  // "Latest" is not a window: it clears the dates (so nothing is filtered by
  // time) and doSearch asks the ranking to fuse in a newest-first list, so
  // relevance still decides the top and recency breaks ties.
  latest: () => ({ after: "", before: "" }),
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

// The message-type combobox looks like a filter only while it is doing
// something: "Any message type" is the plain control, any other position gets
// the accent.
function syncMailFilter(select) {
  const el = select || document.getElementById("notify-filter");
  el.classList.toggle("active", !!el.value);
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

// --- Account filter + name resolution (straight from Thunderbird) ---

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
  const data = await SarvaIndex.health();
  const indexState = data.collection === "green" || data.collection === "yellow" ? "ok" : data.collection;
  const items = [
    ["Qdrant", data.qdrant],
    ["Ollama", data.ollama],
    ["Index", indexState],
  ];
  el.innerHTML = items
    .map(([name, st]) => `<span class="health-dot ${st === "ok" ? "healthy" : "unhealthy"}"></span><span>${name}</span>`)
    .join("");
}

async function loadStats() {
  const el = document.getElementById("management-stats");
  const cards = document.getElementById("account-cards");
  try {
    const stats = await SarvaIndex.stats();
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
  const headline = [status.paused ? `${label} — paused` : label, counts, flags]
    .filter(Boolean)
    .join(" · ");

  let pace = "";
  // Time spent paused is not time the job spent working: freeze the clock at
  // pausedAt and subtract everything held so far, or resuming a job paused for
  // an hour shows a rate 60x too low.
  const endMs = status.paused && status.pausedAt ? status.pausedAt : Date.now();
  const elapsedMs = status.startedAt ? endMs - status.startedAt - (status.pausedMs || 0) : 0;
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

// One button, two jobs: its label always states what the NEXT click does.
function syncPauseButton(paused) {
  const btn = document.getElementById("pause-btn");
  if (!btn) return;
  btn.textContent = paused ? "Resume" : "Pause";
  btn.title = paused
    ? "Continue the job from where it stopped."
    : "Pause between messages: the job keeps its place, and Resume continues from there.";
}

async function togglePause() {
  // Read the live status instead of trusting a cached flag: another window can
  // pause it, and the job can finish, between two polls.
  const status = await bg({ type: "getStatus" });
  if (!status || !status.running) {
    showToast("No index job is running");
    return;
  }
  const want = status.paused ? "resume" : "pause";
  const r = await bg({ type: want });
  if (!r || r.reason === "idle") {
    showToast(`Nothing to ${want}`);
  } else if (want === "pause") {
    showToast("Index job paused — Resume picks up where it stopped");
  } else {
    showToast("Index job resumed");
  }
  pollStatusOnce();
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
      progressEl.classList.toggle("paused", !!status.paused);
      syncPauseButton(!!status.paused);
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
      (result.failed ? ` · ${result.failed.toLocaleString()} skipped, see the browser console` : "");
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
    const qdrant = await SarvaQdrant.version();
    el.textContent = `addon v${clientVersion} · qdrant v${qdrant}`;
    el.title = `Addon v${clientVersion} · Qdrant v${qdrant}`;
    // BM25 text queries need Qdrant 1.20 or newer; keyword search silently
    // returns nothing on anything older, so say it instead.
    const major = Number(String(qdrant).split(".")[0] || 0);
    const minor = Number(String(qdrant).split(".")[1] || 0);
    if (major < 1 || (major === 1 && minor < 20)) {
      el.textContent = `addon v${clientVersion} · qdrant v${qdrant} (needs 1.20+)`;
      el.classList.add("mismatch");
      el.title = `Qdrant ${qdrant} is too old: keyword search needs 1.20 or newer.`;
    }
  } catch (e) {
    el.textContent = `addon v${clientVersion} · qdrant unreachable`;
    el.title = `Could not reach Qdrant: ${e.message}`;
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
  document.getElementById("notify-filter").addEventListener("change", (e) => {
    syncMailFilter(e.target);
    searchIfQuery();
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
  document.getElementById("pause-btn").addEventListener("click", togglePause);

  await initModeToggle();
  syncMailFilter();
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
