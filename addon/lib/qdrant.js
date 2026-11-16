'use strict';
// Qdrant REST client. Exposes globalThis.AIOSQdrant.
//
// Qdrant is the whole index: it holds the vectors, the message payloads, the
// content hashes and the BM25 text indexes. The JavaScript here is a thin REST
// wrapper, not a database.
//
// Collection layout (see ensure()):
//   vector       unnamed, Cosine, sized by the embedding model
//   payload      account (keyword), date_ms (integer),
//                header_only / encrypted (bool),
//                subject / from / to / body (text, prefix tokenizer, BM25)
(function () {
  const TEXT_FIELDS = ['subject', 'from', 'to', 'body'];

  async function config() {
    const s = await AIOSSettings.get();
    return {
      base: AIOSHttp.join(s.qdrantUrl, ''),
      collection: s.collection,
      headers: s.qdrantApiKey ? { 'api-key': s.qdrantApiKey } : {},
      timeoutMs: 60000,
    };
  }

  async function call(method, path, body, opts = {}) {
    const c = await config();
    return AIOSHttp.request(c.base + path, {
      method,
      body,
      headers: c.headers,
      timeoutMs: opts.timeoutMs || c.timeoutMs,
      retries: opts.retries,
    });
  }

  function coll(path) {
    return `/collections/${encodeURIComponent(path)}`;
  }

  async function version() {
    const info = await call('GET', '/', undefined, { timeoutMs: 8000, retries: 0 });
    return (info && info.version) || 'unknown';
  }

  async function health() {
    try {
      const v = await version();
      return { ok: true, version: v };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function collectionInfo() {
    const s = await AIOSSettings.get();
    return call('GET', coll(s.collection), undefined, { timeoutMs: 15000, retries: 0 });
  }

  async function exists() {
    try {
      await collectionInfo();
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  // Create the collection and every index it needs. Idempotent: safe to run on
  // every startup, and it repairs a collection that lost an index (deleted by
  // hand, say).
  async function ensure(dimensions) {
    const s = await AIOSSettings.get();
    if (!(await exists())) {
      await call('PUT', coll(s.collection), {
        vectors: { size: dimensions, distance: 'Cosine' },
        on_disk_payload: true,
      });
    }
    const info = await collectionInfo();
    const schema = (info && info.result && info.result.payload_schema) || {};
    const wanted = [
      ['account', { type: 'keyword' }],
      ['date_ms', { type: 'integer' }],
      ['header_only', { type: 'bool' }],
      ['encrypted', { type: 'bool' }],
    ];
    for (const field of TEXT_FIELDS) {
      wanted.push([
        field,
        { type: 'text', tokenizer: 'prefix', lowercase: true, min_token_len: 2, scoring: { type: 'bm25' } },
      ]);
    }
    for (const [field, field_schema] of wanted) {
      if (schema[field]) continue;
      await call('PUT', `${coll(s.collection)}/index?wait=true`, { field_name: field, field_schema });
    }
    return true;
  }

  async function upsert(points) {
    if (!points.length) return null;
    const s = await AIOSSettings.get();
    return call('PUT', `${coll(s.collection)}/points?wait=false`, { points }, { timeoutMs: 120000 });
  }

  async function retrieve(ids) {
    if (!ids.length) return [];
    const s = await AIOSSettings.get();
    const out = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const res = await call('POST', `${coll(s.collection)}/points`, {
        ids: ids.slice(i, i + 1000),
        with_payload: true,
        with_vector: false,
      });
      out.push(...((res && res.result) || []));
    }
    return out;
  }

  async function setPayload(ids, payload) {
    if (!ids.length) return null;
    const s = await AIOSSettings.get();
    return call('POST', `${coll(s.collection)}/points/payload?wait=false`, { payload, points: ids });
  }

  async function deletePoints(ids) {
    if (!ids.length) return null;
    const s = await AIOSSettings.get();
    return call('POST', `${coll(s.collection)}/points/delete?wait=false`, { points: ids });
  }

  function query(body) {
    return config().then((c) =>
      AIOSHttp.json(c.base + `${coll(c.collection)}/points/query`, body, {
        headers: c.headers,
        timeoutMs: 120000,
      })
    );
  }

  async function scroll(body) {
    const s = await AIOSSettings.get();
    return call('POST', `${coll(s.collection)}/points/scroll`, body, { timeoutMs: 120000 });
  }

  async function count(filter) {
    const s = await AIOSSettings.get();
    const res = await call('POST', `${coll(s.collection)}/points/count`, { exact: true, filter }, {
      timeoutMs: 30000,
    });
    return (res && res.result && res.result.count) || 0;
  }

  async function facet(key, limit) {
    const s = await AIOSSettings.get();
    const res = await call('POST', `${coll(s.collection)}/facet`, { key, limit: limit || 50, exact: true });
    return (res && res.result && res.result.hits) || [];
  }

  async function drop() {
    const s = await AIOSSettings.get();
    return call('DELETE', coll(s.collection));
  }

  globalThis.AIOSQdrant = {
    TEXT_FIELDS,
    version,
    health,
    collectionInfo,
    exists,
    ensure,
    upsert,
    retrieve,
    setPayload,
    deletePoints,
    query,
    scroll,
    count,
    facet,
    drop,
  };
})();
