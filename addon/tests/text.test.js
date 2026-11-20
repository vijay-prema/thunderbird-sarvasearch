'use strict';
// Identity + hashing primitives, pinned to fixed fixtures. If any of these
// drift, stored points stop being found (the point id changes) or every message
// looks new (the hash changes) — a silent, expensive bug. The fixtures are
// literals on purpose: they are the data format, not an implementation detail.

const test = require('node:test');
const assert = require('node:assert');
const { loadLib } = require('./harness');

loadLib('text');
const T = globalThis.SarvaText;

test('uuid5 point ids are stable', async () => {
  const cases = [
    ['account2', 'q1w2e3r4t5y6u7i8+9o0p@mail.example.com', '0e9e0811-5bda-5907-ac99-8b136b6f9d82'],
    ['account2', 'local:8637', 'e0d46cef-f892-58df-9565-95f8f0343539'],
    ['account7', 'CAF=abc.def+123@mail.example.com', 'de306a3c-860e-536c-ac79-04156d1d4a48'],
  ];
  for (const [account, messageId, expected] of cases) {
    assert.strictEqual(await T.pointId(account, messageId), expected, `${account} / ${messageId}`);
  }
});

test('embed text matches build_embed_text byte for byte', () => {
  const doc = {
    from: 'Priya Nair <priya@example.com>',
    to: 'Sam Okafor <sam@example.org>',
    subject: 'Invoice #10001 - Job #20002',
    date: '2026-06-24T09:15:00.000Z',
    body: 'Hi Sam,\n\nPlease find attached invoice 10001 for job 20002.\n\nThanks,\nPriya',
  };
  const expected =
    'From: Priya Nair <priya@example.com>\nTo: Sam Okafor <sam@example.org>\n' +
    'Subject: Invoice #10001 - Job #20002\nDate: 2026-06-24T09:15:00.000Z\n\n' +
    'Hi Sam,\n\nPlease find attached invoice 10001 for job 20002.\n\nThanks,\nPriya';
  assert.strictEqual(T.embedText(doc), expected);
});

test('content hash matches sha256 of the embed text', async () => {
  const doc = {
    from: 'Priya Nair <priya@example.com>',
    to: 'Sam Okafor <sam@example.org>',
    subject: 'Invoice #10001 - Job #20002',
    date: '2026-06-24T09:15:00.000Z',
    body: 'Hi Sam,\n\nPlease find attached invoice 10001 for job 20002.\n\nThanks,\nPriya',
  };
  assert.strictEqual(
    await T.contentHash(doc),
    '875a75d248847a312c37b9344739eda40b944fc3fe4841d952b55ddec9051a34'
  );
});

test('lone surrogates are repaired, then hash stably', async () => {
  const broken = { subject: 'price \ud83d drop', body: 'a \ud83d b' };
  const repaired = T.repairDoc(broken);
  assert.strictEqual(repaired.subject, 'price \ufffd drop');
  assert.strictEqual(repaired.body, 'a \ufffd b');
  // A retry of the same broken text must hash identically, or the message
  // re-embeds forever.
  assert.strictEqual(await T.contentHash(broken), await T.contentHash(repaired));
  // Valid emoji (a real pair) must survive.
  const emoji = 'party \ud83c\udf89 time';
  assert.strictEqual(T.repair(emoji), emoji);
  assert.strictEqual(T.repairDoc({ x: ['ok \ud83c\udf89', 'bad \ude00 pair'] }).x[1], 'bad \ufffd pair');
});

// A snippet is the body's first 200 characters, so a URL at its end arrives as
// a prefix — and opening a prefix goes somewhere else. extendUrl completes it
// from the stored body; both halves have to agree on where a URL ends.
test('a URL cut by the snippet is completed from the body', () => {
  const body =
    'Hi Casey, the invoice is up at https://billing.example.com/invoices/4471?token=ab12 and the signed copy follows.';
  const snippet = body.slice(0, 60); // cuts inside the URL, as PREVIEW_LEN would
  const shown = T.trimUrlTail(snippet.slice(snippet.indexOf('https://')));

  assert.strictEqual(shown, 'https://billing.example.com/i');
  assert.strictEqual(T.extendUrl(body, shown), 'https://billing.example.com/invoices/4471?token=ab12');
});

test('extendUrl leaves a URL that is already whole alone', () => {
  const body = 'see https://example.com/a. Then more text.';
  assert.strictEqual(T.extendUrl(body, 'https://example.com/a'), 'https://example.com/a');
  // No such URL in the body (a stale or unrelated snippet): return what we got.
  assert.strictEqual(T.extendUrl(body, 'https://nowhere.example.com/x'), 'https://nowhere.example.com/x');
  assert.strictEqual(T.extendUrl('', 'https://example.com/x'), 'https://example.com/x');
});

test('a URL truncation at the body cap cannot be repaired, and is not invented', () => {
  // The body itself ends inside the URL: there is nothing to complete it with,
  // so the prefix is returned unchanged rather than a longer wrong guess.
  const body = 'x https://example.com/really/long/path/that/cuts';
  assert.strictEqual(T.extendUrl(body, 'https://example.com/really'), body.slice(2));
});

test('URL tails lose prose punctuation but keep their own brackets', () => {
  assert.strictEqual(T.trimUrlTail('https://example.com/a.'), 'https://example.com/a');
  assert.strictEqual(T.trimUrlTail('https://example.com/a);'), 'https://example.com/a');
  assert.strictEqual(T.trimUrlTail('https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  // Closes a bracket the URL opened itself, then prose: keep the URL's own pair.
  assert.strictEqual(T.trimUrlTail('https://example.com/a(b)c)'), 'https://example.com/a(b)c');
});

test("the preview's own offset picks the right instance of a repeated prefix", () => {
  // The snippet is the body's prefix, so a URL's offset in the snippet is its
  // offset in the body — that is what pins the right instance.
  const body = 'see https://example.com/a/long first, then https://example.com/a?y=2 and more';
  const snippet = body.slice(0, body.lastIndexOf('https://') + 'https://example.com/a'.length);
  const offset = snippet.lastIndexOf('https://');

  // Without the offset the first occurrence wins and the wrong page opens.
  assert.strictEqual(T.extendUrl(body, 'https://example.com/a'), 'https://example.com/a/long');
  assert.strictEqual(T.extendUrl(body, 'https://example.com/a', offset), 'https://example.com/a?y=2');
});
