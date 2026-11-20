'use strict';
// Per-account colours for the search results. Exposes globalThis.SarvaAccountColors.
//
// Thunderbird lets you give each account a colour, and no WebExtension API
// exposes it (the accounts and folders APIs have no `color` property — it lives
// in the profile's folderTree.json). So there are three sources, most
// authoritative first:
//
//   1. settings.accountColors — what the user picked in this add-on's options
//      page, for when Thunderbird's own colour is not reachable or not wanted;
//   2. the bridge daemon's /accounts/colors — the colour Thunderbird itself
//      shows, read out of the profile by the host side;
//   3. a colour derived from the account id, so two accounts are never the same
//      colour even with no settings and no daemon.
//
// Which source won is kept per account: the card's tooltip says so, because a
// generated colour looks exactly like a real one and a wrong colour is worse
// than an explained one.
(function () {
  // Chosen to stay distinct on light and dark cards and to work as a small dot;
  // a generated colour only has to separate accounts, not match anything.
  const PALETTE = [
    '#1c71d8',
    '#c01c28',
    '#26a269',
    '#ff7800',
    '#813d9c',
    '#c64600',
    '#0d8ba8',
    '#a51d2d',
    '#1a5fb4',
    '#5e5c64',
  ];

  // FNV-1a over the account id: stable for the life of the account, and cheap
  // enough to run per result card.
  function hashColor(accountId) {
    const text = String(accountId || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return PALETTE[(hash >>> 0) % PALETTE.length];
  }

  function normalise(value) {
    if (typeof value !== 'string') return null;
    const hex = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(hex)) {
      return '#' + hex.slice(1).split('').map((c) => c + c).join('').toLowerCase();
    }
    return null;
  }

  const CACHE_MS = 5 * 60 * 1000;
  const SOURCE_LABEL = {
    settings: 'Colour set in the SarvaSearch options',
    thunderbird: "Thunderbird's account colour",
    generated: 'Generated to tell accounts apart — set a colour in the SarvaSearch options to choose it',
  };

  const state = {
    overrides: {},
    fromThunderbird: {},
    loadedAt: 0,
    bridgeError: null,
  };

  // The daemon reads the profile and returns {"account2": "#ff7800", ...}.
  // A failure is not an error state for the UI: it just means we fall back.
  async function loadFromBridge() {
    let settings;
    try {
      settings = await SarvaSettings.get();
    } catch (e) {
      return;
    }
    if (settings.bridgeEnabled === false) {
      state.fromThunderbird = {};
      return;
    }
    const base = String(settings.bridgeUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const headers = settings.bridgeToken ? { 'x-sarva-bridge-token': settings.bridgeToken } : {};
    try {
      const data = await SarvaHttp.request(`${base}/accounts/colors`, {
        headers,
        timeoutMs: 4000,
        retries: 0,
      });
      const colors = {};
      for (const [account, value] of Object.entries((data && data.colors) || {})) {
        const hex = normalise(value);
        if (hex) colors[account] = hex;
      }
      state.fromThunderbird = colors;
      state.bridgeError = null;
    } catch (e) {
      // Keep whatever we had: a daemon that restarted mid-session should not
      // repaint every card in generated colours.
      state.bridgeError = e.message;
    }
  }

  // Re-read the overrides on every call (cheap, and the options page writes
  // them from another tab) but only ask the daemon when the answer is stale.
  async function load({ force = false } = {}) {
    const settings = await SarvaSettings.get();
    const overrides = {};
    for (const [account, value] of Object.entries(settings.accountColors || {})) {
      const hex = normalise(value);
      if (hex) overrides[account] = hex;
    }
    state.overrides = overrides;

    const stale = force || !state.loadedAt || Date.now() - state.loadedAt > CACHE_MS;
    if (stale) {
      state.loadedAt = Date.now();
      await loadFromBridge();
    }
    return snapshot();
  }

  function colorFor(accountId) {
    const id = String(accountId || '');
    const override = state.overrides[id];
    if (override) return { color: override, source: 'settings', label: SOURCE_LABEL.settings };
    const fromThunderbird = state.fromThunderbird[id];
    if (fromThunderbird) {
      return { color: fromThunderbird, source: 'thunderbird', label: SOURCE_LABEL.thunderbird };
    }
    return { color: hashColor(id), source: 'generated', label: SOURCE_LABEL.generated };
  }

  function snapshot() {
    return {
      overrides: { ...state.overrides },
      fromThunderbird: { ...state.fromThunderbird },
      bridgeError: state.bridgeError,
      loadedAt: state.loadedAt,
    };
  }

  // Tests need a cold start; nothing in the add-on does, because a page load
  // already gives one.
  function reset() {
    state.overrides = {};
    state.fromThunderbird = {};
    state.loadedAt = 0;
    state.bridgeError = null;
  }

  globalThis.SarvaAccountColors = {
    PALETTE,
    hashColor,
    normalise,
    load,
    colorFor,
    snapshot,
    reset,
  };
})();
