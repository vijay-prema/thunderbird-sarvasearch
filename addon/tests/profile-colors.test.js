'use strict';
// The bridge reads account colours out of a Thunderbird profile. This is the
// one place where account ids ("account2", which the add-on indexes) are tied to
// the folder URI that carries the colour, so the fixtures below mirror a real
// profile: prefs.js for the account/server/identity graph, folderTree.json for
// the colours.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const colors = require('../../tools/lib/account-colors');

const PREFS = `// Mozilla User Preferences
user_pref("mail.accountmanager.accounts", "account1,account2,account3,account4");
user_pref("mail.account.account1.identities", "id1");
user_pref("mail.account.account1.server", "server1");
user_pref("mail.account.account2.identities", "id2");
user_pref("mail.account.account2.server", "server2");
user_pref("mail.account.account3.identities", "id3");
user_pref("mail.account.account3.server", "server3");
user_pref("mail.account.account4.server", "server4");
user_pref("mail.server.server1.type", "imap");
user_pref("mail.server.server1.hostname", "imap.example.com");
user_pref("mail.identity.id1.useremail", "user@example.com");
user_pref("mail.server.server2.type", "imap");
user_pref("mail.server.server2.hostname", "imap.mail.example.net");
user_pref("mail.identity.id2.useremail", "sam@example.net");
user_pref("mail.server.server3.type", "imap");
user_pref("mail.server.server3.hostname", "imap.example.com");
user_pref("mail.identity.id3.useremail", "second@example.com");
user_pref("mail.server.server4.type", "none");
user_pref("mail.server.server4.hostname", "Local Folders");
`;

const TREE = {
  open: { all: [], smart: [] },
  colors: {
    'imap://user%40example.com@imap.example.com': '#26a269',
    // Same host, different account: only the address tells them apart.
    'imap://second%40example.com@imap.example.com': '#ff7800',
    // The URI keeps the address the account was created with, which is not one
    // of this account's identities — the unique host is what identifies it.
    'imap://alias%40example.net@imap.mail.example.net': '#57e389',
    'mailbox://nobody@Local%20Folders': '#4cbf40',
    // One folder's own colour, not the account's.
    'imap://user%40example.com@imap.example.com/Archive': '#c01c28',
  },
};

function profile({ prefs = PREFS, tree = TREE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarva-profile-'));
  fs.writeFileSync(path.join(dir, 'prefs.js'), prefs);
  fs.writeFileSync(path.join(dir, 'folderTree.json'), JSON.stringify(tree));
  return dir;
}

test('account ids map to the colours Thunderbird stores for them', () => {
  const dir = profile();
  const result = colors.readAccountColors({ profile: dir });

  assert.deepStrictEqual(result.colors, {
    account1: '#26a269',
    account2: '#57e389',
    account3: '#ff7800',
    account4: '#4cbf40',
  });
  // A folder inside an account has its own colour; using it as the account's
  // colour would repaint every card in that account red.
  assert.ok(!Object.values(result.colors).includes('#c01c28'));
});

test('prefs.js is parsed tolerantly', () => {
  const prefs = colors.parsePrefs(
    [
      '// a comment',
      'user_pref("a.string", "with a \\" inside");',
      'user_pref("a.int", 42);',
      'user_pref("a.bool", true);',
      'stale line without a semicolon',
    ].join('\n')
  );
  assert.strictEqual(prefs.get('a.string'), 'with a " inside');
  assert.strictEqual(prefs.get('a.int'), 42);
  assert.strictEqual(prefs.get('a.bool'), true);
});

test('folder URIs decode their user and host', () => {
  assert.deepStrictEqual(colors.parseFolderUri('imap://user%40example.com@imap.example.com/Archive'), {
    scheme: 'imap',
    user: 'user@example.com',
    host: 'imap.example.com',
    folder: 'Archive',
  });
  // Non-special scheme with a space in the host — Node's URL would fight us.
  assert.deepStrictEqual(colors.parseFolderUri('mailbox://nobody@Local%20Folders'), {
    scheme: 'mailbox',
    user: 'nobody',
    host: 'local folders',
    folder: '',
  });
  assert.strictEqual(colors.parseFolderUri('not a uri'), null);
});

test('an account with no colour set is simply absent', () => {
  const dir = profile({ prefs: PREFS, tree: { colors: {} } });
  const result = colors.readAccountColors({ profile: dir });
  assert.deepStrictEqual(result.colors, {});
  assert.strictEqual(result.accounts, 4);
  assert.strictEqual(result.resolved, 0);
});

test('a missing profile is not an error', () => {
  const result = colors.readAccountColors({ profile: path.join(os.tmpdir(), 'does-not-exist-xyz') });
  assert.strictEqual(result.profile, path.join(os.tmpdir(), 'does-not-exist-xyz'));
  assert.deepStrictEqual(result.colors, {});
});

test('the profile in use is picked by folderTree.json mtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sarva-home-'));
  const root = path.join(home, '.thunderbird');
  const older = path.join(root, 'aaa.default');
  const newer = path.join(root, 'zzz.default-release');
  for (const dir of [older, newer]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'folderTree.json'), '{}');
  }
  fs.utimesSync(path.join(older, 'folderTree.json'), new Date(2000, 1, 1), new Date(2000, 1, 1));
  fs.utimesSync(path.join(newer, 'folderTree.json'), new Date(2024, 1, 1), new Date(2024, 1, 1));

  assert.deepStrictEqual(colors.listProfiles({ home }), [newer, older]);
  assert.strictEqual(colors.findProfile({ home }), newer);
  // An explicit --profile always wins.
  assert.strictEqual(colors.findProfile({ home, profile: older }), older);
});
