'use strict';
// Hybrid search over Qdrant. Exposes globalThis.AIOSSearch.
//
// Two engines, fused with RRF:
//
//   keyword  Qdrant BM25 text indexes, weighted subject 8 : from 4 : to 2 : body 1
//   semantic Ollama embedding -> Qdrant cosine
//
// Qdrant has both halves natively, but it does not report which engine ranked a
// hit at what position — and the result cards show exactly that
// ("sem #3 · kw #7"). So the ranking maths lives here, in JavaScript, where it
// is testable without any service running:
//
//  1. per-field BM25 text queries (prefix tokenized, so "invo" finds "invoice")
//  2. those four ranked lists are fused with the configured field weights
//     -> one keyword ranking, with each field's rank kept for the UI
//  3. hybrid fuses that keyword ranking with the semantic ranking, 1/(k+rank)
//  4. "Latest" keeps that candidate set and orders it newest first, with the
//     fused relevance position only breaking same-date ties.
//
// Field weighting needs the per-field step: a single Qdrant text query over a
// concatenated field cannot express "subject counts eight times as much".
(function () {
  const VALID_MODES = ['hybrid', 'semantic', 'keyword'];
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  class SemanticUnavailable extends Error {}

  // ISO date (whole local day) or datetime -> epoch ms.
  function parseBound(value, end) {
    if (!value) return null;
    let ms;
    if (DATE_ONLY.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      const dt = new Date(y, m - 1, d); // local midnight
      if (end) dt.setDate(dt.getDate() + 1); // inclusive through the whole day
      ms = dt.getTime();
    } else {
      ms = Date.parse(value);
    }
    if (!Number.isFinite(ms)) throw new Error(`Invalid date filter '${value}'`);
    return ms;
  }

  function rankingLists(lists, weights, k) {
    // lists: [{name, hits: [{key, score}]}] -> ordered [{key, score, ranks}]
    const total = new Map();
    for (const { name, hits } of lists) {
      const weight = weights[name] == null ? 1 : weights[name];
      if (!weight) continue;
      hits.forEach((hit, i) => {
        const entry = total.get(hit.key) || { key: hit.key, score: 0, ranks: {} };
        entry.score += weight / (k + i + 1);
        entry.ranks[name] = { rank: i + 1, score: hit.score };
        total.set(hit.key, entry);
      });
    }
    return [...total.values()].sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
  }

  // Fuse the semantic and keyword rankings: 1/(k+rank) per engine, summed.
  function fuse(rankings, k) {
    const total = new Map();
    for (const [engine, list] of Object.entries(rankings)) {
      list.forEach((hit, i) => {
        const entry = total.get(hit.key) || { key: hit.key, score: 0, ranks: {} };
        entry.score += 1 / (k + i + 1);
        entry.ranks[engine] = { rank: i + 1, score: hit.score };
        total.set(hit.key, entry);
      });
    }
    return [...total.values()].sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
  }

  // "Latest": relevance decides WHICH mail is in play (the fused candidate
  // set), this decides the ORDER — newest first. Equal dates keep their fused
  // relevance position, so same-day hits do not flip arbitrarily. Undated
  // candidates (date_ms 0) go last.
  function latestOrder(fused, dates) {
    const relevance = new Map(fused.map((hit, i) => [hit.key, i]));
    return [...fused].sort(
      (a, b) =>
        (dates.get(b.key) || 0) - (dates.get(a.key) || 0) ||
        relevance.get(a.key) - relevance.get(b.key)
    );
  }

  function keyOf(payload) {
    return `${payload.account || ''}\u0000${payload.message_id || ''}`;
  }

  function buildFilter({ account, from, to, after, before }) {
    const must = [];
    if (account) must.push({ key: 'account', match: { value: account } });
    // MatchText on the text-indexed sender/recipient: token-based, so
    // "acme" and "priya@acme-plumbing" both hit, without a full scan.
    if (from) must.push({ key: 'from', match: { text: from } });
    if (to) must.push({ key: 'to', match: { text: to } });
    const range = {};
    const afterMs = parseBound(after, false);
    const beforeMs = parseBound(before, true);
    if (afterMs != null) range.gte = afterMs;
    if (beforeMs != null) range.lt = beforeMs;
    if (Object.keys(range).length) must.push({ key: 'date_ms', range });
    return must.length ? { must } : undefined;
  }

  async function textHits(query, field, filter, limit) {
    const res = await AIOSQdrant.query({
      query: { text: query },
      using: field,
      limit,
      filter,
      with_payload: ['account', 'message_id'],
      with_vector: false,
    });
    return ((res && res.result && res.result.points) || []).map((p) => ({
      key: keyOf(p.payload || {}),
      score: p.score,
    }));
  }

  async function keywordRanking(query, filter, candidates, s) {
    const fields = ['subject', 'from', 'to', 'body'];
    const lists = [];
    for (const field of fields) {
      const weight = (s.keywordWeights && s.keywordWeights[field]) || 0;
      if (!weight) continue;
      lists.push({ name: field, hits: await textHits(query, field, filter, candidates) });
    }
    return rankingLists(lists, s.keywordWeights || {}, s.rrfK || 60);
  }

  async function semanticRanking(query, filter, candidates) {
    let vector;
    try {
      const vectors = await AIOSOllama.embed([query]);
      vector = vectors[0];
      if (!vector) throw new Error('the embedding service returned no vector');
    } catch (e) {
      throw new SemanticUnavailable(e.message);
    }
    const res = await AIOSQdrant.query({
      query: vector,
      limit: candidates,
      filter,
      with_payload: ['account', 'message_id'],
      with_vector: false,
    });
    return ((res && res.result && res.result.points) || []).map((p) => ({
      key: keyOf(p.payload || {}),
      score: p.score,
    }));
  }

  function recordOf(payload) {
    return {
      message_id: payload.message_id || '',
      account: payload.account || '',
      account_name: payload.account_name || '',
      subject: payload.subject || '',
      from: payload.from || '',
      to: payload.to || '',
      date: payload.date || '',
      date_ms: payload.date_ms || 0,
      folders: payload.folders || [],
      snippet: payload.snippet || '',
      header_only: !!payload.header_only,
      encrypted: !!payload.encrypted,
      numeric_id: payload.numeric_id == null ? null : payload.numeric_id,
      attachments: payload.attachments || [],
    };
  }

  // Message payloads by result key. Keys are (account, Message-ID), and the
  // point id is derived from them, so this is the one place that needs the
  // derivation.
  async function payloadsFor(keys) {
    const ids = await Promise.all(
      keys.map((key) => {
        const [account, messageId] = key.split('\u0000');
        return AIOSText.pointId(account, messageId);
      })
    );
    const out = new Map();
    for (const p of await AIOSQdrant.retrieve(ids)) {
      const payload = p.payload || {};
      out.set(keyOf(payload), payload);
    }
    return out;
  }

  function emptyResult(query, mode, latest) {
    return {
      query,
      mode,
      mode_used: mode,
      latest: !!latest,
      results: [],
      engines: { semantic: { available: true, candidates: 0 }, keyword: { candidates: 0 } },
    };
  }

  // search({query, mode, latest, limit, account, from, to, after, before}) ->
  // the shape the result cards and the status line read.
  async function search(req) {
    const s = req.settings || (await AIOSSettings.get());
    const mode = VALID_MODES.includes(req.mode) ? req.mode : s.mode || 'hybrid';
    const latest = !!req.latest;
    const query = String(req.query || '').trim();
    const limit = Math.max(1, Math.min(100, req.limit || s.limit || 20));
    if (!query) return emptyResult(query, mode, latest);

    const filter = buildFilter(req);
    const candidates = Math.min(100, limit * Math.max(1, s.candidatesMultiplier || 3));

    // The collection is created on first use. Keyword-only search skips this:
    // it needs no embedding, so it keeps working with Ollama down.
    if (mode !== 'keyword') await AIOSIndex.ensureReady();

    let keywordHits = [];
    if (mode !== 'semantic') {
      keywordHits = await keywordRanking(query, filter, candidates, s);
    }

    let semanticHits = [];
    let semanticAvailable = true;
    if (mode !== 'keyword') {
      try {
        semanticHits = await semanticRanking(query, filter, candidates);
      } catch (e) {
        if (mode === 'semantic') throw e;
        semanticAvailable = false; // hybrid degrades to keyword-only
        console.warn('[AI OmniSearch] semantic engine unavailable, keyword-only:', e.message);
      }
    }

    // One fusion for every mode: each mode contributes the ranking lists it
    // actually has, so "Latest" reorders the same pool in all three.
    const rankings = {};
    if (mode !== 'semantic') rankings.keyword = keywordHits;
    if (mode !== 'keyword' && semanticAvailable) rankings.semantic = semanticHits;

    const modeUsed = mode === 'hybrid' && !semanticAvailable ? 'keyword (semantic unavailable)' : mode;
    let ordered = fuse(rankings, s.rrfK || 60);

    // "Latest" needs the candidates' dates before the top-N slice is taken, so
    // their payloads are fetched here and reused for the result cards below.
    let payloads = null;
    if (latest) {
      payloads = await payloadsFor(ordered.map((hit) => hit.key));
      const dates = new Map();
      for (const [key, payload] of payloads) dates.set(key, payload.date_ms || 0);
      ordered = latestOrder(ordered, dates);
    }

    if (mode === 'keyword') {
      // Keyword ranking is already fused across fields; keep the per-field
      // detail the result cards display.
      const fieldsByKey = new Map(keywordHits.map((h) => [h.key, h.ranks]));
      for (const hit of ordered) if (fieldsByKey.has(hit.key)) hit.fields = fieldsByKey.get(hit.key);
    }

    const top = ordered.slice(0, limit);
    if (!payloads) payloads = await payloadsFor(top.map((hit) => hit.key));

    const results = [];
    for (const hit of top) {
      const payload = payloads.get(hit.key);
      if (!payload) continue; // deleted between the query and the fetch
      results.push({
        ...recordOf(payload),
        score: hit.score,
        engines: {
          semantic: hit.ranks.semantic || null,
          keyword: hit.ranks.keyword || null,
        },
      });
    }

    return {
      query,
      mode,
      mode_used: modeUsed,
      latest,
      results,
      engines: {
        semantic: { available: semanticAvailable, candidates: semanticHits.length },
        keyword: { candidates: keywordHits.length },
      },
    };
  }

  globalThis.AIOSSearch = {
    search,
    parseBound,
    fuse,
    rankingLists,
    latestOrder,
    SemanticUnavailable,
    buildFilter,
  };
})();
