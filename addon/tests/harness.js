'use strict';
// Test harness: loads the add-on's real lib/*.js files into a Node test process
// and provides fake `messenger`, Qdrant and Ollama.
//
// The lib files are browser IIFEs that publish globals (AIOSHttp, AIOSIndex,
// ...). Loading the ACTUAL files — rather than re-implementing them in the
// test — is the point: `node --check` would happily pass a version whose
// ranking or folder-merge logic is wrong.

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');

function loadLib(...names) {
  for (const name of names) {
    const code = fs.readFileSync(path.join(LIB, `${name}.js`), 'utf8');
    // Indirect eval: runs in global scope, so the IIFE's globalThis assignment
    // is visible to every other module.
    (0, eval)(code);
  }
}

function fakeStorage(initial = {}) {
  const store = { ...initial };
  const local = {
    get: async (key) => {
      if (key == null) return { ...store };
      if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
      if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
      return {};
    },
    set: async (obj) => {
      Object.assign(store, obj);
    },
    remove: async (key) => {
      delete store[key];
    },
  };
  return { local, __store: store };
}

function installMessenger(initial = {}) {
  globalThis.messenger = { storage: fakeStorage(initial) };
  return globalThis.messenger;
}

// In-memory Qdrant stand-in. Mirrors the REST surface AIOSIndex/AIOSSearch use.
function fakeQdrant({ points = new Map(), failUpsertWhen = null } = {}) {
  const calls = { upsert: 0, setPayload: 0, delete: 0, query: [], scroll: 0, drop: 0 };
  return {
    points,
    calls,
    async exists() {
      return true;
    },
    async ensure() {},
    async retrieve(ids) {
      return ids.filter((id) => points.has(id)).map((id) => ({ id, payload: points.get(id).payload }));
    },
    async upsert(list) {
      calls.upsert += 1;
      if (failUpsertWhen && list.some(failUpsertWhen)) throw new Error('rejected payload');
      for (const p of list) points.set(p.id, { vector: p.vector, payload: p.payload });
    },
    async setPayload(ids, payload) {
      calls.setPayload += 1;
      for (const id of ids) {
        const entry = points.get(id);
        if (entry) entry.payload = { ...entry.payload, ...payload };
      }
    },
    async deletePoints(ids) {
      calls.delete += 1;
      for (const id of ids) points.delete(id);
    },
    async scroll(body) {
      calls.scroll += 1;
      const all = [...points.entries()].map(([id, e]) => ({ id, payload: e.payload }));
      const start = body.offset ? Number(body.offset) : 0;
      const page = all.slice(start, start + (body.limit || 100));
      const next = start + page.length < all.length ? start + page.length : null;
      return { result: { points: page, next_page_offset: next } };
    },
    async query(body) {
      calls.query.push(body);
      const hits = (body.__hits || []);
      return { result: { points: hits } };
    },
    async count() {
      return points.size;
    },
    async facet() {
      return [];
    },
    async drop() {
      calls.drop += 1;
      points.clear();
    },
  };
}

function fakeOllama({ dims = 4, failFor = () => false } = {}) {
  const calls = { embed: 0, texts: [] };
  return {
    calls,
    async dimensions() {
      return dims;
    },
    async embed(texts) {
      calls.embed += 1;
      calls.texts.push(...texts);
      return texts.map((t) => {
        if (failFor(t)) return null;
        const v = new Array(dims).fill(0);
        v[0] = t.length;
        return v;
      });
    },
    async health() {
      return { ok: true };
    },
  };
}

function installSettings(overrides = {}) {
  const settings = {
    qdrantUrl: 'http://127.0.0.1:6333',
    qdrantApiKey: '',
    collection: 'test',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'nomic-embed-text',
    limit: 20,
    openIn: 'tab',
    mode: 'hybrid',
    includeSpamTrash: false,
    indexEncryptedBodies: false,
    bodyLimit: 4000,
    excludedAccounts: [],
    embedBatch: 64,
    keywordWeights: { subject: 8, from: 4, to: 2, body: 1 },
    rrfK: 60,
    candidatesMultiplier: 3,
    ...overrides,
  };
  globalThis.AIOSSettings = { get: async () => settings, save: async (p) => ({ ...settings, ...p }), ensure: async () => settings };
  return settings;
}

module.exports = { loadLib, installMessenger, fakeStorage, fakeQdrant, fakeOllama, installSettings };
