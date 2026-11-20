# Working in this repository

Conventions for anyone — human or agent — changing SarvaSearch.

## No real personal data, ever

The index is built from a real mailbox and this repository is public. Fixtures, tests,
docs, comments, examples, screenshots and demo media must be synthetic:

- **Reserved domains only**: `example.com`, `example.net`, `example.org`, and the
  `.test` / `.invalid` / `.localhost` names (RFC 2606 and RFC 6761). Never a real
  provider, employer, client or personal domain — a `gmail.com` address in a fixture
  is a leak even when the mailbox part is invented.
- No real names of people or organisations, phone numbers, street addresses, account
  numbers, or copy-pasted message content. The existing fixtures use `user@example.com`,
  `Casey`, `Account A`, `Example Power Co`; keep to that register.
- Files that mirror a real Thunderbird profile (`prefs.js`, `folderTree.json`,
  `folderCache.json`) are synthetic *shapes*, not captured data. Re-create the shape;
  never paste a real profile, not even a fragment of one.
- `addon/tests/no-pii.test.js` enforces the email-address half of this across
  `addon/`, `tools/`, `docs/`, `skills/` and the READMEs. If it fails, fix the fixture —
  do not add an allowlist entry.

The add-on's own identity (`author`, `homepage_url` and the `gecko.id` in
`addon/manifest.json`) is project metadata rather than fixture data, and the id is
load-bearing: changing it makes Thunderbird treat this as a different add-on, with
empty storage and the old install left behind.

## Before calling a change done

```bash
npm test        # node --test, loads the real lib/ and tools/ files
npm run check    # node --check over every add-on and tool script
npm run build    # sarvasearch-<version>.xpi (plain JS, just zipped)
```

Page scripts (`addon/search`, `addon/options`) are not in the unit-test set: load them
in a browser with a `messenger` stub and exercise the real events before shipping a UI
change.
