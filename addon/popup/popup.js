// Popup search bar. Submits open the results in a new tab and close the popup.
// A strip at the bottom mirrors live indexing progress while the popup is
// open; clicking it opens the search page, whose index panel has the detail
// (counts, header-only tally, rate and ETA).

let jobPoll = null;

async function openSearch(query) {
  // Resolve to an absolute moz-extension:// URL so the path isn't treated as
  // relative to the popup's own location (popup/popup.html).
  const base = messenger.runtime.getURL("search/search.html");
  const url = query ? `${base}?q=${encodeURIComponent(query)}` : base;
  await messenger.tabs.create({ url });
  window.close();
}

const PHASE_SHORT = {
  building: "Indexing",
  "catching-up": "Indexing",
  reconciling: "Verifying",
};

async function refreshJobStrip() {
  const strip = document.getElementById("job-strip");
  if (!strip) return;
  let s = null;
  try {
    s = await messenger.runtime.sendMessage({ type: "getStatus" });
  } catch (e) {
    return;
  }
  if (!s || (!s.running && s.phase === "idle")) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");
  strip.classList.toggle("paused", !!s.paused);
  const fill = document.getElementById("job-fill");
  const text = document.getElementById("job-text");
  // Paused is a state of its own, not a slow percentage: say so in the strip
  // and let the search page own the resume control.
  const label = s.paused ? "Paused" : PHASE_SHORT[s.phase] || s.phase;
  if (s.total > 0) {
    const pct = Math.min(100, Math.floor((s.processed / s.total) * 100));
    fill.style.width = pct + "%";
    fill.classList.remove("indeterminate");
    text.textContent =
      `${label} ${pct}% · ${s.processed.toLocaleString()} / ${s.total.toLocaleString()}`;
  } else {
    fill.style.width = "30%";
    fill.classList.add("indeterminate");
    text.textContent = `${label}…`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const fullLink = document.getElementById("open-full");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) {
      input.focus();
      return;
    }
    openSearch(q);
  });

  fullLink.addEventListener("click", (e) => {
    e.preventDefault();
    openSearch(input.value.trim());
  });

  document.getElementById("open-settings").addEventListener("click", (e) => {
    e.preventDefault();
    messenger.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById("job-strip").addEventListener("click", () => openSearch(""));
  refreshJobStrip();
  jobPoll = setInterval(refreshJobStrip, 2000);
});
