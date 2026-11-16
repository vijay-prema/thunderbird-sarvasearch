'use strict';
// Ollama embedding client. Exposes globalThis.SarvaOllama.
//
// One rule earns the bisecting code below: Ollama rejects a whole /api/embed
// request when a single input is unacceptable (a document that is not valid
// UTF-8 after repair, an input the model refuses). Halving the batch until the
// offending text stands alone keeps one bad message from failing the other 63
// in its chunk — and returns null for it so the caller can skip just that one.
(function () {
  let dimsCache = 0;

  async function conn() {
    const s = await SarvaSettings.get();
    return { base: SarvaHttp.join(s.ollamaUrl, ''), model: s.ollamaModel, batch: Math.max(1, s.embedBatch || 64) };
  }

  async function health() {
    try {
      const c = await conn();
      await SarvaHttp.request(c.base + '/api/tags', { timeoutMs: 8000, retries: 0 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function embedOnce(texts) {
    const c = await conn();
    // truncate:true asks Ollama itself to cut over-long input at the model's
    // context instead of erroring — the commonest reason a batch fails.
    const res = await SarvaHttp.json(c.base + '/api/embed', {
      model: c.model,
      input: texts,
      truncate: true,
    }, { timeoutMs: 300000, retries: 1 });
    const vectors = (res && res.embeddings) || [];
    if (vectors.length !== texts.length) {
      throw new Error(`Ollama returned ${vectors.length} embeddings for ${texts.length} inputs`);
    }
    return vectors;
  }

  // Returns an array aligned with `texts`; null where that single text could
  // not be embedded.
  async function embedChunk(texts) {
    try {
      return await embedOnce(texts);
    } catch (e) {
      if (texts.length === 1) return [null];
      const mid = Math.floor(texts.length / 2);
      const left = await embedChunk(texts.slice(0, mid));
      const right = await embedChunk(texts.slice(mid));
      return left.concat(right);
    }
  }

  async function embed(texts) {
    const out = [];
    const c = await conn();
    for (let i = 0; i < texts.length; i += c.batch) {
      const chunk = texts.slice(i, i + c.batch);
      out.push(...(await embedChunk(chunk)));
    }
    for (const v of out) {
      if (v && v.length) {
        dimsCache = v.length;
        break;
      }
    }
    return out;
  }

  // Vector size for creating the collection: probe once, then remember.
  async function dimensions() {
    if (dimsCache) return dimsCache;
    const vectors = await embed(['dimension probe']);
    if (!vectors[0]) throw new Error('Ollama returned no vector — is the embedding model pulled?');
    dimsCache = vectors[0].length;
    return dimsCache;
  }

  globalThis.SarvaOllama = { health, embed, dimensions };
})();
