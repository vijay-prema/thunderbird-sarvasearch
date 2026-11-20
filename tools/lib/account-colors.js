'use strict';
// Account colours, read out of a Thunderbird profile.
//
// Thunderbird stores an account's colour in the profile's folderTree.json:
//
//   { "colors": { "imap://user%40example.com@imap.example.com": "#ff7800" } }
//
// keyed by the ROOT FOLDER URI — a folder inside an account may carry its own
// colour too, and those keys have a path. No WebExtension API exposes any of
// this (the accounts/folders APIs have no `color` property), so the add-on asks
// the bridge daemon, which is a host process and can read the profile.
//
// Getting from a colour to the add-on's account id (the account key, e.g.
// "account2") needs prefs.js as well:
//
//   mail.account.account2.server      -> server2
//   mail.server.server2.type/hostname -> "imap" / "imap.example.com"
//   mail.account.account2.identities  -> id1,id5 -> their useremail
//
// The URI's username is the server's username pref, which defaults to a
// *default identity address* — but not always one on this account (an alias
// like me@example.com for a user@example.com identity is normal), so the
// match is tried on host + any known address first, then on a host only one
// account uses.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Where Thunderbird keeps profiles, most likely first. Flatpak and snap
// installs live under their own sandbox root; the ESR flatpak is the common
// case on Linux.
function candidateRoots(home = os.homedir()) {
  return [
    path.join(home, '.thunderbird'),
    path.join(home, '.var/app/org.mozilla.thunderbird_esr/.thunderbird'),
    path.join(home, '.var/app/org.mozilla.Thunderbird/.thunderbird'),
    path.join(home, 'snap/thunderbird/common/.thunderbird'),
    path.join(home, 'Library/Thunderbird'),
    path.join(home, 'AppData/Roaming/Thunderbird'),
  ];
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

// prefs.js is one `user_pref("key", value);` per line. Values are JSON-ish
// (quoted strings, integers, true/false), so JSON.parse handles every case
// except a bare integer, which needs no help.
function parsePrefs(text) {
  const prefs = new Map();
  const line = /^\s*user_pref\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(.+?)\s*\)\s*;?\s*$/;
  for (const raw of String(text || '').split('\n')) {
    const m = line.exec(raw);
    if (!m) continue;
    const key = m[1].replace(/\\(.)/g, '$1');
    let value = m[2];
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch (e) {
        continue;
      }
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else {
      const n = Number(value);
      value = Number.isFinite(n) ? n : value;
    }
    prefs.set(key, value);
  }
  return prefs;
}

// imap://user%40example.com@imap.example.com/INBOX  ->  {scheme, user, host, folder}
// Parsed by hand rather than with `new URL`: non-special schemes differ between
// Node versions in whether they decode the host, and the URI is our key.
function parseFolderUri(uri) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*)@([^/?#]+)(\/[^?#]*)?/i.exec(String(uri || ''));
  if (!m) return null;
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  };
  return {
    scheme: m[1].toLowerCase(),
    user: decode(m[2]).trim().toLowerCase(),
    host: decode(m[3]).trim().toLowerCase(),
    folder: decode(m[4] || '').replace(/^\/+|\/+$/g, ''),
  };
}

function normaliseColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return '#' + hex.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  }
  return null;
}

// Profile directories that actually hold a folderTree.json, newest first —
// a machine with several profiles should follow the one in use, not the
// alphabetically first.
function listProfiles({ home = os.homedir(), roots = candidateRoots(home) } = {}) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, 'folderTree.json')).mtimeMs;
      } catch (e) {
        continue; // not a profile, or never opened the folder pane
      }
      found.push({ dir, mtime });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((p) => p.dir);
}

function findProfile(opts = {}) {
  if (opts.profile) return opts.profile;
  const profiles = listProfiles(opts);
  return profiles.length ? profiles[0] : null;
}

// Root-folder colours only: a key with a path is one folder's own colour, not
// the account's.
function rootColors(tree) {
  const colors = {};
  for (const [uri, value] of Object.entries((tree && tree.colors) || {})) {
    const parsed = parseFolderUri(uri);
    const color = normaliseColor(value);
    if (!parsed || !color || parsed.folder) continue;
    colors[uri] = { ...parsed, uri, color };
  }
  return Object.values(colors);
}

function accountsFromPrefs(prefs) {
  const listed = String(prefs.get('mail.accountmanager.accounts') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // An account can be missing from the manager list while its keys survive.
  if (!listed.length) {
    for (const key of prefs.keys()) {
      const m = /^mail\.account\.([^.]+)\.server$/.exec(key);
      if (m) listed.push(m[1]);
    }
  }
  return listed.map((id) => {
    const server = prefs.get(`mail.account.${id}.server`) || '';
    const addresses = String(prefs.get(`mail.account.${id}.identities`) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((key) => prefs.get(`mail.identity.${key}.useremail`))
      .filter(Boolean);
    return {
      id,
      type: String(prefs.get(`mail.server.${server}.type`) || ''),
      host: String(prefs.get(`mail.server.${server}.hostname`) || ''),
      username: String(prefs.get(`mail.server.${server}.username`) || ''),
      addresses,
    };
  });
}

function matchAccount(account, roots, used, accounts) {
  const host = account.host.trim().toLowerCase();
  if (!host) return null;
  const names = new Set(
    [account.username, ...account.addresses]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase())
  );
  const free = roots.filter((r) => !used.has(r.uri));
  const byAddress = free.find((r) => r.host === host && names.has(r.user));
  if (byAddress) return byAddress;
  // A host only one account uses identifies it even when the URI's username is
  // an alias we cannot know (mail.server.<key>.username is often unset, and the
  // URI keeps whatever address the account was created with).
  const sameHost = accounts.filter((a) => a.host.trim().toLowerCase() === host);
  if (sameHost.length === 1) return free.find((r) => r.host === host) || null;
  return null;
}

/**
 * accountKey -> "#rrggbb" for every account whose colour could be resolved.
 * Unset colours are simply absent: the add-on has its own fallback.
 */
function readAccountColors(opts = {}) {
  const profile = findProfile(opts);
  if (!profile) return { profile: null, colors: {}, accounts: 0, resolved: 0 };

  const prefs = parsePrefs(safeRead(path.join(profile, 'prefs.js')));
  let tree = {};
  try {
    tree = JSON.parse(safeRead(path.join(profile, 'folderTree.json')) || '{}');
  } catch (e) {
    tree = {};
  }

  const roots = rootColors(tree);
  const accounts = accountsFromPrefs(prefs);
  const used = new Set();
  const colors = {};
  for (const account of accounts) {
    const hit = matchAccount(account, roots, used, accounts);
    if (!hit) continue;
    used.add(hit.uri);
    colors[account.id] = hit.color;
  }
  return { profile, colors, accounts: accounts.length, resolved: Object.keys(colors).length };
}

module.exports = {
  candidateRoots,
  listProfiles,
  findProfile,
  parsePrefs,
  parseFolderUri,
  normaliseColor,
  accountsFromPrefs,
  readAccountColors,
};
