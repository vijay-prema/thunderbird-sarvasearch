'use strict';
// Ranking: weighted per-field BM25 lists, RRF fusion, and the degradation path
// when Ollama is down. The maths is the whole search experience, so it is
// asserted against hand-computed reciprocal-rank values rather than "it
// returned something".

const test = require('node:test');
const assert = require('node:assert');
const { loadLib, installMessenger, fakeQdrant, fakeOllama, installSettings } = require('./harness');

loadLib('text', 'search');

function setup({ hitsByField = {}, ollamaOpts = {}, settings = {}, points = [] } = {}) {
  installMessenger();
  const qdrant = fakeQdrant();
  for (const p of points) qdrant.points.set(p.id, { payload: p.payload });
  qdrant.query = async (body) => {
    if (Array.isArray(body.query)) return { result: { points: body.__semantic || [] } };
    const hits = hitsByField[body.using] || [];
    return { result: { points: hits } };
  };
  const ollama = fakeOllama(ollamaOpts);
  globalThis.AIOSQdrant = qdrant;
  globalThis.AIOSOllama = ollama;
  globalThis.AIOSIndex = { ensureReady: async () => {} };
  installSettings(settings);
  return { qdrant, ollama };
}

function hit(id, score) {
  return { id: `id-${id}`, score, payload: { account: 'acct', message_id: id } };
}

async function pointIdFor(messageId) {
  return globalThis.AIOSText.pointId('acct', messageId);
}

test('rankings are fused per field with the configured weights', async () => {
  const ids = ['a', 'b', 'c'];
  const points = await Promise.all(
    ids.map(async (m) => ({ id: await pointIdFor(m), payload: { account: 'acct', message_id: m, subject: m } }))
  );
  setup({
    points,
    hitsByField: {
      subject: [hit('a', 9), hit('b', 8)],
      body: [hit('b', 7), hit('c', 6)],
    },
  });

  const res = await globalThis.AIOSSearch.search({ query: 'x', mode: 'keyword', limit: 10 });
  // subject weight 8, body weight 1, k=60:
  //   b = 8/62 + 1/61 = 0.1454   a = 8/61 = 0.1311   c = 1/62 = 0.0161
  assert.deepStrictEqual(res.results.map((r) => r.message_id), ['b', 'a', 'c']);
  assert.strictEqual(res.results[0].engines.keyword.rank, 1);
  assert.strictEqual(res.results[0].engines.semantic, null);
});

test('field rank is preserved for the result card', async () => {
  const points = [{ id: await pointIdFor('b'), payload: { account: 'acct', message_id: 'b' } }];
  setup({ points, hitsByField: { subject: [hit('b', 9)], body: [hit('b', 3)] } });

  const res = await globalThis.AIOSSearch.search({ query: 'x', mode: 'keyword', limit: 5 });
  assert.strictEqual(res.results[0].engines.keyword.rank, 1);
});

test('hybrid fuses semantic and keyword ranks', async () => {
  const points = await Promise.all(
    ['a', 'b', 'd'].map(async (m) => ({ id: await pointIdFor(m), payload: { account: 'acct', message_id: m } }))
  );
  const { qdrant } = setup({ points, hitsByField: { subject: [hit('a', 9), hit('b', 8)] } });
  // semantic ranking: d, b
  qdrant.query = async (body) =>
    Array.isArray(body.query) ? { result: { points: [hit('d', 0.9), hit('b', 0.8)] } } : { result: { points: body.using === 'subject' ? [hit('a', 9), hit('b', 8)] : [] } };

  const res = await globalThis.AIOSSearch.search({ query: 'x', mode: 'hybrid', limit: 10 });
  // b: kw#2 1/62 + sem#2 1/62 = 0.03226; d: sem#1 1/61 = 0.01639; a: kw#1 1/61 = 0.01639
  // b first; a and d tie, broken by key for stability.
  assert.strictEqual(res.results[0].message_id, 'b');
  assert.strictEqual(res.results.length, 3);
  const b = res.results[0];
  assert.deepStrictEqual(b.engines.semantic, { rank: 2, score: 0.8 });
  assert.deepStrictEqual(b.engines.keyword, { rank: 2, score: b.engines.keyword.score });
  assert.strictEqual(res.engines.semantic.candidates, 2);
  assert.strictEqual(res.engines.keyword.candidates, 2);
});

test('hybrid degrades to keyword when the embedder is down', async () => {
  const points = [{ id: await pointIdFor('a'), payload: { account: 'acct', message_id: 'a' } }];
  setup({
    points,
    hitsByField: { subject: [hit('a', 9)] },
    ollamaOpts: { failFor: () => true },
  });

  const res = await globalThis.AIOSSearch.search({ query: 'x', mode: 'hybrid', limit: 5 });
  assert.strictEqual(res.mode_used, 'keyword (semantic unavailable)');
  assert.strictEqual(res.engines.semantic.available, false);
  assert.strictEqual(res.results[0].message_id, 'a');
});

test('semantic mode surfaces the embedder failure instead of hiding it', async () => {
  setup({ ollamaOpts: { failFor: () => true } });
  await assert.rejects(
    () => globalThis.AIOSSearch.search({ query: 'x', mode: 'semantic', limit: 5 }),
    /no vector|SemanticUnavailable|embedding/i
  );
});

test('keyword mode never calls the embedder', async () => {
  const { ollama } = setup({ hitsByField: { subject: [hit('a', 9)] } });
  await globalThis.AIOSSearch.search({ query: 'x', mode: 'keyword', limit: 5 });
  assert.strictEqual(ollama.calls.embed, 0);
});

test('date bounds are inclusive days, local time', async () => {
  const P = globalThis.AIOSSearch.parseBound;
  assert.strictEqual(P('2026-03-01', false), new Date(2026, 2, 1).getTime());
  assert.strictEqual(P('2026-03-01', true), new Date(2026, 2, 2).getTime());
  assert.throws(() => P('not-a-date', false), /Invalid date filter/);
});

test('filters become a Qdrant filter with range and text matches', () => {
  const f = globalThis.AIOSSearch.buildFilter({
    account: 'acct',
    from: 'acme',
    after: '2026-01-01',
    before: '2026-02-01',
  });
  assert.deepStrictEqual(f.must[0], { key: 'account', match: { value: 'acct' } });
  assert.deepStrictEqual(f.must[1], { key: 'from', match: { text: 'acme' } });
  const range = f.must.find((c) => c.key === 'date_ms').range;
  assert.strictEqual(range.gte, new Date(2026, 0, 1).getTime());
  assert.strictEqual(range.lt, new Date(2026, 1, 2).getTime());
});

test('an empty query returns no results and no calls', async () => {
  const { qdrant } = setup({});
  const before = qdrant.calls.query.length;
  const res = await globalThis.AIOSSearch.search({ query: '   ', mode: 'hybrid', limit: 5 });
  assert.deepStrictEqual(res.results, []);
  assert.strictEqual(qdrant.calls.query.length, before);
});
