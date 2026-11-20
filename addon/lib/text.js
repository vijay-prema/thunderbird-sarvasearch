'use strict';
// Text + identity primitives. Exposes globalThis.SarvaText.
//
// Three conversions happen here, and all three are load-bearing — change one
// and every stored point stops matching:
//
// 1. surrogate repair — Thunderbird's MIME decoding can hand us half of an
//    emoji (a body cut at the length cap). A lone surrogate cannot be encoded
//    as UTF-8, so it would fail the whole ingest batch. Repair to U+FFFD
//    BEFORE hashing, so a retry of the same broken text hashes the same.
// 2. embed text + content hash — the hash is what makes re-indexing cheap:
//    the same message hashes to the same value and is skipped.
// 3. the Qdrant point id — uuid5(NAMESPACE_URL, "account|message-id"). Deriving
//    it here means a message maps to one point no matter which folder it is
//    read from, without a local id table.
(function () {
  // A well-formed emoji is one code point (or one valid pair), so an unpaired
  // surrogate here is always half of a broken character.
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

  function repair(value) {
    return typeof value === 'string' ? value.replace(LONE_SURROGATE, '\ufffd') : value;
  }

  // Repair every string in a plain doc (strings + arrays of strings), which is
  // exactly the shape the ingest path sends.
  function repairDoc(doc) {
    const out = {};
    for (const [k, v] of Object.entries(doc || {})) {
      if (typeof v === 'string') out[k] = repair(v);
      else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? repair(x) : x));
      else out[k] = v;
    }
    return out;
  }

  // The exact text the embedding model sees. Changing this changes every
  // content hash, so it is a data-format constant, not a preference.
  function embedText(p) {
    return (
      `From: ${p.from || ''}\nTo: ${p.to || ''}\nSubject: ${p.subject || ''}\n` +
      `Date: ${p.date || ''}\n\n${p.body || ''}`
    );
  }

  async function sha256Hex(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function contentHash(p) {
    return sha256Hex(embedText(p));
  }

  // ---- uuid5 (RFC 4122 §4.3) over the URL namespace ----
  const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

  function uuidBytes(uuid) {
    const hex = uuid.replace(/-/g, '');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToUuid(b) {
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function uuid5(name) {
    const ns = uuidBytes(NAMESPACE_URL);
    const nameBytes = new TextEncoder().encode(name);
    const data = new Uint8Array(ns.length + nameBytes.length);
    data.set(ns, 0);
    data.set(nameBytes, ns.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
    const b = hash.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50; // version 5
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    return bytesToUuid(b);
  }

  // One message -> one point, across every folder it appears in.
  function pointId(accountId, messageId) {
    return uuid5(`${accountId}|${messageId}`);
  }

  // "From: ..." text is what the model embedded, but a result card shows the
  // body's own opening, so the snippet is computed from the body alone.
  function snippetOf(p, max) {
    if (p.snippet) return p.snippet;
    const body = String(p.body || '').replace(/\s+/g, ' ').trim();
    return body.slice(0, max || 200);
  }

  // ---- URLs in a body preview ----
  // A snippet is the first N characters of the body, so a URL that crosses that
  // cut arrives here as a prefix. Opening a prefix navigates somewhere else (a
  // 404, or worse, a different page), so the page completes it from the stored
  // body before opening it.

  // Prose wraps URLs in punctuation far more often than a URL ends with it. A
  // closing bracket is kept when the URL opened one itself: the ")" in
  // ".../wiki/Foo_(bar)" belongs to the address.
  function trimUrlTail(url) {
    let out = String(url || '').replace(/[.,;:!?'"”’]+$/, '');
    const pairs = { ')': '(', ']': '[', '}': '{' };
    for (;;) {
      const last = out.slice(-1);
      const opener = pairs[last];
      if (!opener) return out;
      const opens = out.split(opener).length - 1;
      const closes = out.split(last).length - 1;
      if (closes <= opens) return out;
      out = out.slice(0, -1);
    }
  }

  // The full URL that starts with `partial`, read from the longer body text.
  // `offset` is where the URL sat in the snippet, which is the same offset in the
  // body when the snippet is a raw prefix of it — that pins the right instance
  // when the same address appears twice. Returns `partial` when the body cannot
  // extend it (the body is capped too, so a URL can straddle that cap instead).
  function extendUrl(body, partial, offset) {
    const text = String(body || '');
    if (!partial) return partial;
    let at = -1;
    if (Number.isInteger(offset) && offset >= 0 && text.startsWith(partial, offset)) at = offset;
    if (at < 0) at = text.indexOf(partial);
    if (at < 0) return partial;
    let end = at + partial.length;
    while (end < text.length && !/[\s<>"'`]/.test(text[end])) end += 1;
    return trimUrlTail(text.slice(at, end));
  }

  globalThis.SarvaText = {
    repair,
    repairDoc,
    embedText,
    sha256Hex,
    contentHash,
    uuid5,
    pointId,
    snippetOf,
    trimUrlTail,
    extendUrl,
  };
})();
