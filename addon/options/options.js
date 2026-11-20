// Options page logic for the SarvaSearch addon.
//
// Connection settings are the two services the add-on talks to: Qdrant (the
// index) and Ollama (the embedder). The health check probes those endpoints with
// the values currently in the form — testing what is about to be saved, not the
// saved copy.

let jobPoll = null;

async function loadSettings() {
  return SarvaSettings.get();
}

async function renderSettings() {
  const s = await loadSettings();

  document.getElementById("qdrant-url").value = s.qdrantUrl;
  document.getElementById("qdrant-key").value = s.qdrantApiKey;
  document.getElementById("collection").value = s.collection;
  document.getElementById("ollama-url").value = s.ollamaUrl;
  document.getElementById("ollama-model").value = s.ollamaModel;
  document.getElementById("limit").value = s.limit;
  document.getElementById("body-limit").value = s.bodyLimit;
  document.getElementById("include-spam-trash").checked = !!s.includeSpamTrash;
  document.getElementById("index-encrypted").checked = !!s.indexEncryptedBodies;

  const mode = s.mode || "hybrid";
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;

  const openIn = s.openIn || "tab";
  document.querySelector(`input[name="open-in"][value="${openIn}"]`).checked = true;

  document.getElementById("bridge-enabled").checked = s.bridgeEnabled !== false;
  document.getElementById("bridge-url").value = s.bridgeUrl || "http://127.0.0.1:8765";
  document.getElementById("bridge-token").value = s.bridgeToken || "";

  await renderAccountList(s.excludedAccounts || []);
  await renderBridgeStatus();
}

async function renderAccountList(excluded) {
  const container = document.getElementById("account-list");
  container.innerHTML = "";
  let accounts = [];
  try {
    accounts = (await messenger.accounts.list(false)) || [];
  } catch (e) {
    container.innerHTML = '<span class="hint">Could not list accounts</span>';
    return;
  }
  if (!accounts.length) {
    container.innerHTML = '<span class="hint">No mail accounts found</span>';
    return;
  }
  // One colour source for everything below: Thunderbird's own colour when the
  // bridge can read it, otherwise what is saved here, otherwise generated.
  await SarvaAccountColors.load({ force: true });

  for (const account of accounts) {
    const row = document.createElement("div");
    row.className = "account-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `acct-${account.id}`;
    cb.dataset.accountId = account.id;
    cb.checked = !excluded.includes(account.id);

    const label = document.createElement("label");
    label.htmlFor = cb.id;
    label.textContent = account.name || account.id;

    const colour = SarvaAccountColors.colorFor(account.id);
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "account-color";
    swatch.dataset.accountId = account.id;
    // Remember what "following Thunderbird" means for this account: saving a
    // value equal to it keeps the account on automatic, so a colour changed in
    // Thunderbird later still comes through.
    swatch.dataset.auto = colour.color;
    swatch.value = colour.color;
    swatch.title = `Colour used for this account on the search results — ${colour.label.toLowerCase()}`;

    const source = document.createElement("span");
    source.className = "color-source";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "color-reset";
    reset.textContent = "auto";
    reset.title = "Follow Thunderbird's colour for this account again";
    reset.addEventListener("click", () => {
      swatch.value = swatch.dataset.auto;
      syncSource();
    });

    function syncSource() {
      const custom = swatch.value.toLowerCase() !== swatch.dataset.auto.toLowerCase();
      source.textContent = custom ? "set here" : colour.source === "thunderbird" ? "Thunderbird" : colour.source;
      reset.hidden = !custom;
    }
    swatch.addEventListener("input", syncSource);
    syncSource();

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(swatch);
    row.appendChild(reset);
    row.appendChild(source);
    container.appendChild(row);
  }
}

async function collectSettings() {
  const excludedAccounts = [];
  for (const cb of document.querySelectorAll("#account-list input[type=checkbox]")) {
    if (!cb.checked) excludedAccounts.push(cb.dataset.accountId);
  }
  // Only accounts whose colour was actually changed are stored; the rest keep
  // following Thunderbird (see renderAccountList).
  const accountColors = {};
  for (const swatch of document.querySelectorAll("#account-list input.account-color")) {
    const value = swatch.value.toLowerCase();
    if (value !== String(swatch.dataset.auto || "").toLowerCase()) {
      accountColors[swatch.dataset.accountId] = value;
    }
  }
  return {
    qdrantUrl: document.getElementById("qdrant-url").value.trim().replace(/\/+$/, ""),
    qdrantApiKey: document.getElementById("qdrant-key").value,
    collection: document.getElementById("collection").value.trim() || "sarvasearch",
    ollamaUrl: document.getElementById("ollama-url").value.trim().replace(/\/+$/, ""),
    ollamaModel: document.getElementById("ollama-model").value.trim() || "nomic-embed-text",
    limit: parseInt(document.getElementById("limit").value, 10) || 20,
    openIn: document.querySelector('input[name="open-in"]:checked').value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    includeSpamTrash: document.getElementById("include-spam-trash").checked,
    indexEncryptedBodies: document.getElementById("index-encrypted").checked,
    bodyLimit: parseInt(document.getElementById("body-limit").value, 10) || 4000,
    excludedAccounts,
    accountColors,
    bridgeEnabled: document.getElementById("bridge-enabled").checked,
    bridgeUrl:
      document.getElementById("bridge-url").value.trim().replace(/\/+$/, "") ||
      "http://127.0.0.1:8765",
    bridgeToken: document.getElementById("bridge-token").value,
  };
}

async function saveSettings() {
  const settings = await collectSettings();
  await SarvaSettings.save(settings);
  // A new endpoint or model means the cached collection state is stale.
  SarvaIndex.invalidate();
  const msg = document.getElementById("saved-msg");
  msg.textContent = "Saved";
  setTimeout(() => (msg.textContent = ""), 2000);
  loadHealth();
  // A new URL/token, or turning the bridge off, must take effect now rather
  // than after the current 25-second long poll expires.
  try {
    await bg({ type: "bridgeRestart" });
  } catch (e) {
    /* background asleep — the next poll reads the saved settings anyway */
  }
  renderBridgeStatus();
}

// --- Health ---

async function loadHealth() {
  const el = document.getElementById("health-section");
  const qdrantUrl = document.getElementById("qdrant-url").value.trim().replace(/\/+$/, "");
  const key = document.getElementById("qdrant-key").value;
  const collection = document.getElementById("collection").value.trim() || "sarvasearch";
  const ollamaUrl = document.getElementById("ollama-url").value.trim().replace(/\/+$/, "");
  const headers = key ? { "api-key": key } : {};

  const row = (label, state, text) =>
    `<div class="health-row"><span class="health-dot ${state === "ok" ? "ok" : "err"}"></span>${escapeHtml(label)}: ${escapeHtml(text)}</div>`;

  if (!qdrantUrl || !ollamaUrl) {
    el.innerHTML = row("Qdrant", "err", "no URL set") + row("Ollama", "err", "no URL set");
    return;
  }

  let qdrantLine;
  try {
    const info = await SarvaHttp.request(SarvaHttp.join(qdrantUrl, "/"), { headers, timeoutMs: 8000, retries: 0 });
    qdrantLine = row("Qdrant", "ok", `v${info.version}`);
  } catch (e) {
    qdrantLine = row("Qdrant", "err", "unreachable");
  }

  let collectionLine;
  try {
    const info = await SarvaHttp.request(
      SarvaHttp.join(qdrantUrl, `/collections/${encodeURIComponent(collection)}`),
      { headers, timeoutMs: 8000, retries: 0 }
    );
    collectionLine = row("Index", "ok", `${collection} (${info.result.points_count} points)`);
  } catch (e) {
    collectionLine = row("Index", "err", "missing — run a rebuild");
  }

  let ollamaLine;
  try {
    await SarvaHttp.request(SarvaHttp.join(ollamaUrl, "/api/tags"), { timeoutMs: 8000, retries: 0 });
    ollamaLine = row("Ollama", "ok", "reachable");
  } catch (e) {
    ollamaLine = row("Ollama", "err", "unreachable — keyword search still works");
  }

  el.innerHTML = qdrantLine + collectionLine + ollamaLine;
}

// --- Agent bridge (see lib/bridge.js + tools/bridge.js) ---

async function renderBridgeStatus() {
  const el = document.getElementById("bridge-status");
  if (!el) return;
  const row = (state, text) =>
    `<div class="health-row"><span class="health-dot ${state === "ok" ? "ok" : "err"}"></span>${escapeHtml(text)}</div>`;
  let st;
  try {
    st = await bg({ type: "bridgeStatus" });
  } catch (e) {
    el.innerHTML = row("err", "Bridge: background script not responding");
    return;
  }
  if (!st || !st.enabled) {
    el.innerHTML = row("err", "Bridge: off");
    return;
  }
  if (st.connected) {
    const when = st.lastOpenedAt ? new Date(st.lastOpenedAt).toLocaleTimeString() : "never";
    el.innerHTML =
      row("ok", `Bridge: connected to ${st.url} — ${st.opened} opened, last ${when}`) +
      (st.lastError ? row("err", `Last error: ${st.lastError}`) : "");
  } else {
    el.innerHTML = row(
      "err",
      `Bridge: no daemon at ${st.url || "(not set)"} — start it with: node tools/bridge.js serve`
    );
  }
}

// --- Index jobs (run in the background script) ---

function bg(message) {
  return messenger.runtime.sendMessage(message);
}

function setJobStatus(text, isError) {
  const el = document.getElementById("job-status");
  el.textContent = text;
  el.className = isError ? "job-error" : "";
}

function jobSummary(result) {
  if (result == null) return "";
  if (result.count != null) {
    return (
      `Indexed ${result.count.toLocaleString()} messages` +
      (result.headerOnly ? ` (${result.headerOnly.toLocaleString()} header-only)` : "")
    );
  }
  if (result.scanned != null) {
    return `Catch-up: scanned ${result.scanned.toLocaleString()}, indexed ${result.added.toLocaleString()}`;
  }
  if (result.removed != null) {
    return `Repaired: +${result.added} indexed, ${result.removed} removed, ${result.folders_updated} folder fixes`;
  }
  return "Done";
}

// The one Pause/Resume button states what the next click does, and is only
// usable while a job is in flight (a paused job still counts as in flight).
function syncPauseButton(status) {
  const btn = document.getElementById("pause-btn");
  if (!btn) return;
  const running = !!(status && status.running);
  const paused = running && !!status.paused;
  btn.disabled = !running;
  btn.textContent = paused ? "Resume" : "Pause";
  btn.title = paused
    ? "Continue the job from where it stopped."
    : "Pause between messages: the job keeps its place, and Resume continues from there.";
}

async function togglePause() {
  // Live status, not a cached flag: the job can be paused elsewhere or finish
  // between two polls.
  const status = await bg({ type: "getStatus" });
  if (!status || !status.running) {
    setJobStatus("No index job is running");
    return;
  }
  const want = status.paused ? "resume" : "pause";
  const r = await bg({ type: want });
  if (!r || r.reason === "idle") {
    setJobStatus(`Nothing to ${want}`);
  } else {
    setJobStatus(want === "pause" ? "Index job paused — Resume picks up where it stopped" : "Index job resumed");
  }
  startPolling();
}

async function pollJob() {
  try {
    const status = await bg({ type: "getStatus" });
    if (!status) return;
    syncPauseButton(status);
    if (status.running || status.phase !== "idle") {
      const counts = `${status.processed.toLocaleString()}/${status.total.toLocaleString()}`;
      setJobStatus(
        status.paused ? `${status.phase} paused at ${counts}` : `${status.phase}... ${counts}`
      );
    } else {
      stopPolling();
      if (status.lastError) setJobStatus(`Last job failed: ${status.lastError}`, true);
      else if (status.lastResult) setJobStatus(jobSummary(status.lastResult));
    }
  } catch (e) {
    stopPolling();
  }
}

function startPolling() {
  if (jobPoll) return;
  pollJob();
  jobPoll = setInterval(pollJob, 2000);
}

function stopPolling() {
  if (jobPoll) {
    clearInterval(jobPoll);
    jobPoll = null;
  }
}

async function runJob(type, label) {
  const r = await bg({ type });
  if (!r || !r.started) {
    setJobStatus((r && r.reason === "busy" ? "Another index job is already running" : `Could not start: ${label}`), true);
    return;
  }
  setJobStatus(`${label} started...`);
  startPolling();
}

// --- Init ---

document.addEventListener("DOMContentLoaded", async () => {
  // Fill the form FIRST: loadHealth() reads the URL fields, and running it
  // before the (async) fill read empty fields — fetching a relative path
  // against moz-extension:// — which showed a permanent red dot even with both
  // services up.
  await renderSettings();
  loadHealth();

  document.getElementById("save-btn").addEventListener("click", saveSettings);
  document.getElementById("rebuild-btn").addEventListener("click", () => runJob("rebuild", "Rebuild"));
  document.getElementById("verify-btn").addEventListener("click", () => runJob("reconcile", "Verify and repair"));
  document.getElementById("pause-btn").addEventListener("click", togglePause);
  document.getElementById("clear-btn").addEventListener("click", async () => {
    if (!confirm("Delete the whole search index? Search finds nothing until you rebuild.")) {
      return;
    }
    try {
      const r = await bg({ type: "clear" });
      // Refused while a job holds the index: clearing under a paused or
      // running job would leave it writing into the new collection.
      if (r && r.cleared === false) {
        setJobStatus("An index job is in flight — pause is not enough, let it finish before clearing", true);
        return;
      }
      setJobStatus("Index cleared. Start a rebuild to re-index your mail.");
      loadHealth();
    } catch (e) {
      setJobStatus(`Clear failed: ${e.message}`, true);
    }
  });

  // Live health while editing the connection fields.
  for (const id of ["qdrant-url", "qdrant-key", "collection", "ollama-url"]) {
    document.getElementById(id).addEventListener("change", loadHealth);
  }

  // Pick up a job already in flight (started from the search page or a
  // startup catch-up) so its progress and the Pause control are live here too.
  const status = await bg({ type: "getStatus" }).catch(() => null);
  if (status && status.running) startPolling();
  else syncPauseButton(status);
});

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}
