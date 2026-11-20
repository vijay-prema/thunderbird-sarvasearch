'use strict';
// Nothing in this repo may carry a real address.
//
// Fixtures, examples and docs are published with the source, and a real mailbox,
// employer or client domain in one outlives the commit that added it. Every email
// address must therefore sit on a reserved name (RFC 2606/6761): example.com,
// example.net, example.org, or a .test / .invalid / .localhost name. The one
// exception is the extension id in addon/manifest.json ("sarvasearch@…"), which
// looks like an address but is the add-on's identity.
//
// This is a leak guard, not a lint pass: it reads the files that ship or are
// published as examples, and it fails loudly with the file and line.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Directories and files that are public (the xpi is built from addon/).
const SCAN = [
  'addon/lib',
  'addon/ingest',
  'addon/search',
  'addon/options',
  'addon/popup',
  'addon/tests',
  'tools',
  'docs',
  'skills',
  'README.md',
  'RELEASE.md',
  'AGENTS.md',
  'package.json',
];
const EXTENSIONS = new Set(['.js', '.mjs', '.md', '.html', '.css', '.json', '.txt', '.yaml', '.yml']);

const RESERVED =
  /(?:^|\.)(?:example\.(?:com|net|org)|test|invalid|localhost)$|^(?:localhost)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function walk(entry, out = []) {
  const full = path.join(ROOT, entry);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (e) {
    return out;
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(full)) walk(path.join(entry, child), out);
    return out;
  }
  if (EXTENSIONS.has(path.extname(full))) out.push(entry);
  return out;
}

test('no real email addresses in shipped code, tests or docs', () => {
  const offenders = [];
  for (const file of SCAN.flatMap((entry) => walk(entry))) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(EMAIL)) {
        const domain = match[1];
        if (RESERVED.test(domain)) continue;
        offenders.push(`${file}:${index + 1}  ${match[0]}`);
      }
    });
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `use example.com/net/org (or .test/.invalid) instead of a real domain:\n  ${offenders.join('\n  ')}`
  );
});

test('the guard actually recognises a real domain', () => {
  // A test that cannot fail is worse than none: pin the matcher itself.
  assert.ok(RESERVED.test('example.com'));
  assert.ok(RESERVED.test('mail.example.org'));
  assert.ok(RESERVED.test('localhost'));
  assert.ok(!RESERVED.test('gmail.com'));
});
