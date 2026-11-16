// Options page logic for the AI OmniSearch addon.
//
// Rewritten for the fork: the upstream thunderbird-ai-search options page was
// IMAP/server-scheduler centric (and its saveSettings had a corrupted line —
// `apiKey: ***("api-key").value` — a broken redaction committed upstream that
// made the whole script fail to parse). This page covers connection, search
// preferences, indexing options, and the rebuild/verify/clear actions.

let jobPoll = null;

const DEFAULTS = {
  serverUrl: "http://localhost:8342",
  apiKey: "",
  limit: 20,
  openIn: "tab",
  mode: "hybrid",
  includeSpamTrash: false,
  indexEncryptedBodies: false,
  bodyLimit: 4000,
  excludedAccounts: [],
};

async function loadSettings() {
  const data = await messenger.storage.local.get("settings");
  return { ...DEFAULTS, ...(data.settings || {}) };
}

async function renderSettings() {
  const s = await loadSettings();

  document.getElementById("server-url").value = s.serverUrl;
  document.getElementById("api-key").value = s.apiKey;
  document.getElementById("limit").value = s.limit;
  document.getElementById("body-limit").value = s.bodyLimit;
  document.getElementById("include-spam-trash").checked = !!s.includeSpamTrash;
  document.getElementById("index-encrypted").checked = !!s.indexEncryptedBodies;

  const mode = s.mode || "hybrid";
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;

  const openIn = s.openIn || "tab";
  document.querySelector(`input[name="open-in"][value="${openIn}"]`).checked = true;

  await renderAccountList(s.excludedAccounts || []);
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
  for (const account of accounts) {
    const row = document.createElement("div");
    row.className = "checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `acct-${account.id}`;
    cb.dataset.accountId = account.id;
    cb.checked = !excluded.includes(account.id);
    const label = document.createElement("label");
    label.htmlFor = cb.id;
    label.textContent = account.name || account.id;
    row.appendChild(cb);
    row.appendChild(label);
    container.appendChild(row);
  }
}

async function collectSettings() {
  const excludedAccounts = [];
  for (const cb of document.querySelectorAll("#account-list input[type=checkbox]")) {
    if (!cb.checked) excludedAccounts.push(cb.dataset.accountId);
  }
  return {
    serverUrl: document.getElementById("server-url").value.trim().replace(/\/+$/, ""),
    apiKey: document.getElementById("api-key").value,
    limit: parseInt(document.getElementById("limit").value, 10) || 20,
    openIn: document.querySelector('input[name="open-in"]:checked').value,
    mode: document.querySelector('input[name="mode"]:checked').value,
    includeSpamTrash: document.getElementById("include-spam-trash").checked,
    indexEncryptedBodies: document.getElementById("index-encrypted").checked,
    bodyLimit: parseInt(document.getElementById("body-limit").value, 10) || 4000,
    excludedAccounts,
  };
}

async function saveSettings() {
  const settings = await collectSettings();
  await messenger.storage.local.set({ settings });
  const msg = document.getElementById("saved-msg");
  msg.textContent = "Saved";
  setTimeout(() => (msg.textContent = ""), 2000);
  loadHealth();
}

// --- Health ---

async function loadHealth() {
  const el = document.getElementById("health-section");
  // Read what is in the form (not necessarily saved yet) so the test
  // reflects what the user is about to save.
  const serverUrl = document.getElementById("server-url").value.trim().replace(/\/+$/, "");
  const apiKey = document.getElementById("api-key").value;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  try {
    const resp = await fetch(serverUrl + "/health", { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const row = (label, st) =>
      `<div class="health-row"><span class="health-dot ${st === "ok" ? "ok" : "err"}"></span>${label}: ${st}</div>`;
    el.innerHTML = row("Qdrant", data.qdrant) + row("Ollama", data.ollama) + row("SQLite", data.sqlite);
  } catch (e) {
    el.innerHTML = `<div class="health-row"><span class="health-dot err"></span>Server unreachable (${escapeHtml(e.message)})</div>`;
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

async function pollJob() {
  try {
    const status = await bg({ type: "getStatus" });
    if (!status) return;
    if (status.running || status.phase !== "idle") {
      setJobStatus(
        `${status.phase}... ${status.processed.toLocaleString()}/${status.total.toLocaleString()}`
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

document.addEventListener("DOMContentLoaded", () => {
  renderSettings();
  loadHealth();

  document.getElementById("save-btn").addEventListener("click", saveSettings);
  document.getElementById("rebuild-btn").addEventListener("click", () => runJob("rebuild", "Rebuild"));
  document.getElementById("verify-btn").addEventListener("click", () => runJob("reconcile", "Verify and repair"));
  document.getElementById("clear-btn").addEventListener("click", async () => {
    if (!confirm("Delete the whole search index on the server? Search finds nothing until you rebuild.")) {
      return;
    }
    try {
      await bg({ type: "clear" });
      setJobStatus("Index cleared. Start a rebuild to re-index your mail.");
    } catch (e) {
      setJobStatus(`Clear failed: ${e.message}`, true);
    }
  });

  // Live health while editing the connection fields.
  document.getElementById("server-url").addEventListener("change", loadHealth);
  document.getElementById("api-key").addEventListener("change", loadHealth);
});

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}
