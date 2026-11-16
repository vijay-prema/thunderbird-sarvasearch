# Thunderbird AI OmniSearch

Hybrid **semantic + keyword** search for Thunderbird, powered entirely by services on
your own machine. The add-on indexes the mail Thunderbird has already downloaded and
writes it **straight into Qdrant** — there is no companion server, no service to
supervise, and no IMAP connection of its own.

This is a fork of [giovi321/thunderbird-ai-search](https://github.com/giovi321/thunderbird-ai-search)
whose IMAP pull-indexer was replaced by Thunderbird-side ingestion ported from
[CR0CKER/thunderbird-omnisearch](https://github.com/CR0CKER/thunderbird-omnisearch)
(MIT — folder walking, MIME text extraction, event handling, catch-up/reconcile and
result-opening logic are adapted from its `lib/`). Both upstreams are MIT licensed;
attribution is preserved in the file headers.

```
┌────────────────────────────┐
│ Thunderbird + add-on       │   embed:  POST /api/embed   ┌──────────┐
│                            │ ──────────────────────────► │  Ollama  │
│  walk folders (local)      │                             └──────────┘
│  read bodies (getFull)     │   upsert / query            ┌──────────┐
│  extract text (workers)    │ ──────────────────────────► │  Qdrant  │
│  events + daily catch-up   │                             └──────────┘
└────────────────────────────┘   vectors + payloads + BM25 indexes
```

## Why

- **Semantic** finds mail by *meaning* ("plumbing invoice" finds "bill for fixing
  the pipes"), using Ollama embeddings stored in Qdrant.
- **Keyword** finds exact words and word *prefixes* ("invo" finds "invoice"), ranking
  subject hits above sender, recipient and body hits. It needs no embedding, so it
  keeps working with Ollama down.
- **Hybrid** (default) runs both and fuses them with Reciprocal Rank Fusion: a
  document at rank *i* in an engine's list contributes `1 / (60 + i)`; only ranks are
  combined, so cosine similarity and BM25 scores are never mixed. `60` is the standard
  constant from the RRF paper (Cormack et al., 2009).

## Requirements

- [Thunderbird](https://www.thunderbird.net/) 128+
- **[Qdrant 1.20 or newer](https://qdrant.tech)** — keyword search uses BM25-scored
  full-text queries, which older versions do not have. The search page warns you if
  your Qdrant is too old.
- [Ollama](https://ollama.ai) with an embedding model:
  `ollama pull nomic-embed-text` (768d, ~274 MB)
- Nothing else. No Python, and Docker only if you want it.

### Thunderbird: download full bodies

The add-on indexes what Thunderbird has on disk — it never opens an IMAP connection.
For complete search coverage, enable offline sync per account:
**Account Settings → Synchronization & Storage → Keep messages on this computer**,
then right-click each folder → **Properties → Synchronization → Fetch messages**.
Mail without a downloaded body is still indexed by subject/sender and shown with a
"header only" badge.

## Install

```bash
./build.sh                      # -> thunderbird-ai-omnisearch-3.0.0.xpi
```

In Thunderbird: **Tools → Add-ons and Themes → gear → Install Add-on From File**.
For a self-built (unsigned) add-on, first set `xpinstall.signatures.required` to
`false` in the Config Editor (`about:config`).

Then open **Add-ons → AI OmniSearch → Options** and point it at your services:

| Setting | Default |
|---|---|
| Qdrant URL | `http://127.0.0.1:6333` |
| Qdrant API key | empty |
| Collection | `ai_omnisearch` |
| Ollama URL | `http://127.0.0.1:11434` |
| Embedding model | `nomic-embed-text` |

The first run starts a full index build automatically (the add-on's background page
walks every folder and pushes batches; embedding speed is the bottleneck — watch
progress in the search page's index panel). Then press **Ctrl+Alt+S** (or the toolbar
button) to search.

### Running Qdrant

Docker, bound to loopback so only your machine — and the add-on — can reach it:

```bash
docker run -d --name qdrant --restart unless-stopped \
  -p 127.0.0.1:6333:6333 -p 127.0.0.1:6334:6334 \
  -v "$HOME/Docker/qdrant/qdrant_storage:/qdrant/storage" \
  qdrant/qdrant:v1.20.0
```

The collection, its payload indexes and its BM25 text indexes are created
automatically on first use — there is nothing to prepare.

## How indexing stays correct

1. **Live events** — all five Thunderbird message events (`onNewMailReceived`,
   `onUpdated`, `onDeleted`, `onMoved`, `onCopied`) are applied immediately: ingest,
   delete, or folder-remove.
2. **Daily catch-up** (and at every Thunderbird start) — re-walks everything newer
   than a per-account watermark (with a 1-day overlap). Covers mail synced while
   Thunderbird was closed, filed server-side, or sent from elsewhere. Events alone
   measurably miss such mail (omnisearch measured 75–100% of some folders missing
   before adding this pull).
3. **Verify and repair** (manual) — diffs the index against every live message:
   deletes stale records, fixes folder drift, re-ingests the missing. Catches the one
   hole a watermark cannot see: back-dated mail imported today.

Re-ingestion is cheap: each point carries a `content_hash` of the embedded text, and
the add-on skips anything whose content already matches — no re-embedding, no
duplicate vectors. A message in several folders (Gmail labels, copies) is **one**
point listing all its folders; it disappears only when the last folder goes.

A message the index rejects (a payload Qdrant will not take) is logged with its
account and Message-ID and skipped, so it cannot abort a 100k-message run that would
restart at the same message every time; the next pass retries it, and the rebuild
summary reports how many were skipped.

## The index (Qdrant collection layout)

| | |
|---|---|
| point id | `uuid5(NAMESPACE_URL, "account|message-id")` — one message, one point |
| vector | dense, Cosine, sized by the embedding model |
| `account` | keyword index (account filter) |
| `date_ms` | integer index (date range filter) |
| `header_only`, `encrypted` | bool indexes (stats) |
| `subject`, `from`, `to`, `body` | text indexes, `prefix` tokenizer, **BM25 scoring** |

The `prefix` tokenizer is what keeps "invo" → "invoice" working: every token prefix is
indexed, at roughly 1.5–2× the size of a word-tokenized index.

Payload: `message_id, account, account_name, subject, from, to, date, date_ms,
folders, snippet, body, header_only, encrypted, numeric_id, attachments,
content_hash, indexed_at`.

## Search modes & filters

| Mode | Engine | Notes |
|---|---|---|
| Hybrid (default) | semantic + keyword, RRF-fused | each result shows `sem #rank` / `kw #rank` |
| Semantic | Ollama embeddings + Qdrant cosine | meaning over exact words |
| Keyword | BM25 per field, weighted (subject 8 : from 4 : to 2 : body 1) | prefix matching; no Ollama needed |

Filters on any mode: account dropdown, sender-contains, a quick date range
(*Any time, Last 7/30/60 days, This week, This month, Last month, This year*, or
custom) and an after/before date range. The quick ranges just fill the two date
inputs, so you can see and adjust the exact window they applied. If Ollama is down,
hybrid silently degrades to keyword-only and says so in the status line.

Result cards also list the message's **attachment file names** (the first three, then
`+N more`, with the rest in the tooltip). Names are captured at index time and are not
part of the embedded text, so a rebuild backfills (and corrects) them without
re-embedding anything.

## Upgrading from 2.x

2.x shipped a Python FastAPI server with its own SQLite keyword index and expected
Qdrant 1.15. 3.0 removed the server: the add-on does that work itself. Two migrations
are involved.

**The add-on** is simply replaced — its options page now wants the Qdrant and Ollama
URLs instead of a server URL, and the old `serverUrl`/`apiKey` settings are dropped
automatically.

**The Qdrant collection** has to be carried across, because Qdrant 1.16 removed the
`rocks_db` payload-index backend that 1.15 wrote into the collection's index config,
and 1.20 refuses to load such a shard (`unknown variant 'rocks_db'`). There is no
forward migration for that config. The tools here move the data **without re-embedding
anything** — vectors are exported as they are:

```bash
# 1. with the OLD Qdrant (1.15) still running
python3 tools/qdrant_export.py --collection ai_omnisearch --out ai_omnisearch.jsonl

# 2. stop it, start Qdrant 1.20 on a fresh storage directory (leave the old one alone)
docker run -d --name qdrant --restart unless-stopped \
  -p 127.0.0.1:6333:6333 -p 127.0.0.1:6334:6334 \
  -v "$HOME/Docker/qdrant/qdrant_storage_v120:/qdrant/storage" \
  qdrant/qdrant:v1.20.0

# 3. import: creates the collection, payload indexes and BM25 text indexes, and
#    recomputes content_hash from the payload (it used to live only in the old
#    server's SQLite — without it the next catch-up would treat every message as
#    new and re-embed the whole mailbox)
python3 tools/qdrant_import.py --collection ai_omnisearch --in ai_omnisearch.jsonl

# 4. check the add-on's own code against the migrated index (no Thunderbird needed)
node tools/verify-live.js --roundtrip
```

The export is resumable (`--offset N`, printed on every progress line) and never
writes to the source collection. Keep the 1.15 storage directory until step 4 passes.

Two deliberate behaviour changes: a message Ollama refuses to embed used to be stored
keyword-only in SQLite — a Qdrant point needs a vector, so 3.0 skips such a message,
remembers the failure, and retries it only when its content changes (or after
**Clear index**). And sender/recipient filters now match whole tokens ("acme" hits
`priya@acme-plumbing`) rather than arbitrary substrings.

## Privacy & security

- Everything stays on your machine: mail bodies go from Thunderbird straight to your
  Qdrant, which asks only your Ollama for embeddings.
- The add-on holds destructive power over the collection (delete, clear, reconcile), so
  **bind Qdrant to `127.0.0.1`** — the Docker command above does. If Qdrant lives on
  another host, set a Qdrant API key in its config and paste it into the add-on.
- Encrypted mail (OpenPGP/S-MIME) is indexed by subject/sender only, by default.
  Opting in to indexing decrypted bodies sends plaintext to Qdrant and stores it
  unencrypted in its payloads — same exposure class as omnisearch's opt-in.
- The add-on requests `http://localhost/*` and `http://127.0.0.1/*` host permissions.
  Running Qdrant or Ollama on another host requires editing `addon/manifest.json`.

## Development

```bash
node --test addon/tests/*.test.js     # ranking, ingest rules, hashing — no services needed
node --check addon/lib/search.js      # syntax-check any file
node tools/verify-live.js             # read-only checks against your real Qdrant+Ollama
node tools/verify-live.js --roundtrip # + ingest/repair/delete in a throwaway collection
./build.sh --dev                      # development .xpi with branch+sha
```

The unit tests load the **real** `addon/lib/*.js` files (plain browser IIFEs) with fake
`messenger`/Qdrant/Ollama objects, so a broken ranking or folder-merge rule fails here
rather than in a mailbox.

```
addon/
  lib/            http, settings, text (hash + uuid5), qdrant, ollama, index, search
  ingest/         dockey, extract (+worker), reader, open, events
  search/         search page
  options/ popup/ icons/
  tests/          node:test suites + harness
tools/            qdrant_export.py, qdrant_import.py, verify-live.js
```

## Credits

- **[giovi321/thunderbird-ai-search](https://github.com/giovi321/thunderbird-ai-search)** (MIT) —
  add-on UI, options page and Ollama embedding semantics.
- **[CR0CKER/thunderbird-omnisearch](https://github.com/CR0CKER/thunderbird-omnisearch)** (MIT) —
  the mail-reading side: folder walking, body extraction across cores, event wiring,
  watermark catch-up, reconcile, and stable Message-ID-based opening (their
  `docs/adr/0001` on why numeric ids silently go wrong is required reading).

## License

MIT — see [LICENSE](LICENSE).
