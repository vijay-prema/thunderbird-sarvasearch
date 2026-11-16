# Thunderbird AI OmniSearch

Hybrid **semantic + keyword** search for Thunderbird — powered entirely by services
on your own machine (Ollama + Qdrant), with **no IMAP connections of its own**: the
add-on indexes the mail Thunderbird has already downloaded.

This is a fork of [giovi321/thunderbird-ai-search](https://github.com/giovi321/thunderbird-ai-search)
(v2.0 diverges) with its IMAP pull-indexer replaced by Thunderbird-side ingestion
ported from [CR0CKER/thunderbird-omnisearch](https://github.com/CR0CKER/thunderbird-omnisearch)
(MIT — folder walking, MIME text extraction, event handling, catch-up/reconcile and
result-opening logic are adapted from its `lib/`), plus a new hybrid search layer.
Both upstreams are MIT licensed; attribution is preserved in the file headers.

```
┌────────────────────────────┐         ┌─────────────────────────────────┐
│ Thunderbird                │  push   │ Search server (this repo)       │
│                            │ ──────► │                                 │
│  add-on:                   │  /ingest│  FastAPI                        │
│   walk folders (local)     │         │   ├─ Ollama  → embeddings       │
│   read bodies (getFull)    │ ◄────── │   ├─ Qdrant  → semantic vectors │
│   extract text (workers)   │  search │   └─ SQLite FTS5 → keyword index│
│                            │         │                                 │
│   events + daily catch-up  │         │  Bring your own Ollama+Qdrant  │
└────────────────────────────┘         └─────────────────────────────────┘
```

## Why

- **Semantic** finds mail by *meaning* ("plumbing invoice" finds "bill for fixing
  the pipes") — but needs Ollama running and is fuzzy about exact words.
- **Keyword** finds exact words and prefixes ("invo" finds "invoice"), ranks
  subject/sender matches above body matches, and works even when Ollama is down.
- **Hybrid** (default) runs both and fuses them with Reciprocal Rank Fusion:
  a document at rank *i* in an engine's list scores `1 / (60 + i)`, summed over
  engines. Only ranks are combined, so cosine similarity and bm25 scores never
  get mixed; a message both engines like lands on top. `60` is the standard
  constant from the RRF paper (Cormack et al., 2009).

## Requirements

- [Thunderbird](https://www.thunderbird.net/) 128+
- [Ollama](https://ollama.ai) with an embedding model:
  `ollama pull nomic-embed-text` (768d, ~274 MB)
- [Qdrant](https://qdrant.ai) (native binary or Docker — it just needs to be
  reachable at a URL)
- Python 3.11+ for the server (or Docker)

### Thunderbird: download full bodies

The add-on indexes what Thunderbird has on disk — it never opens an IMAP
connection. For complete search coverage, enable offline sync per account:
**Account Settings → Synchronization & Storage → Keep messages on this computer**,
then right-click each folder → **Properties → Synchronization → Fetch messages**.
Mail without a downloaded body is still indexed by subject/sender and shown with
a "header only" badge.

## Setup

### 1. Server

Native (recommended if Ollama/Qdrant already run on this machine):

```bash
git clone https://github.com/vijay-prema/thunderbird-ai-omnisearch.git
cd thunderbird-ai-omnisearch
cp config.example.yaml config.yaml   # edit if your Ollama/Qdrant live elsewhere
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
.venv/bin/python -m server.main
```

Or Docker (`host.docker.internal` reaches Ollama/Qdrant running on the host):

```bash
cp config.example.yaml config.yaml
docker compose up -d --build
```

Verify:

```bash
curl http://localhost:8342/health
# {"qdrant":"ok","ollama":"ok","sqlite":"ok"}
```

### 2. Add-on

```bash
./build.sh          # produces thunderbird-ai-omnisearch-<version>.xpi
```

In Thunderbird: **Tools → Add-ons and Themes → gear → Install Add-on From File**.
For a self-built (unsigned) add-on, first set `xpinstall.signatures.required` to
`false` in the Config Editor (`about:config`).

The first run starts a full index build automatically (the add-on's background
page walks every folder and pushes batches to the server; embedding speed is the
bottleneck — watch progress in the search page's index panel). Then press
**Ctrl+Alt+S** (or the toolbar button) to search.

## How indexing stays correct

Same architecture as thunderbird-omnisearch, adapted to a server target:

1. **Live events** — all five Thunderbird message events (`onNewMailReceived`,
   `onUpdated`, `onDeleted`, `onMoved`, `onCopied`) are applied immediately:
   ingest, delete, or folder-remove.
2. **Daily catch-up** (and at every Thunderbird start) — re-walks everything
   newer than a per-account watermark (with a 1-day overlap). Covers mail synced
   while Thunderbird was closed, filed server-side, or sent from elsewhere.
   Events alone measurably miss such mail (omnisearch measured 75–100% of some
   folders missing before adding this pull).
3. **Verify and repair** (manual) — diffs the server's index against every live
   message: deletes stale records, fixes folder drift, re-ingests the missing.
   Catches the one hole a watermark cannot see: back-dated mail imported today.

Re-ingestion is cheap: each message carries a content hash, and the server skips
anything whose content already matches — no re-embedding, no duplicate vectors.
A message in several folders (Gmail labels, copies) is **one** record listing all
its folders; it disappears only when the last folder goes.

## Search modes & filters

| Mode | Engine | Notes |
|---|---|---|
| Hybrid (default) | semantic + keyword, RRF-fused | each result shows `sem #rank` / `kw #rank` |
| Semantic | Ollama embeddings + Qdrant cosine | meaning over exact words |
| Keyword | SQLite FTS5, bm25 with column weights (subject 8 : from 4 : to 2 : body 1) | prefix matching; no Ollama needed |

Filters on any mode: account dropdown, sender-contains, and an after/before date
range. If Ollama is down, hybrid silently degrades to keyword-only and says so in
the status line.

## Server API

| Endpoint | What it does |
|---|---|
| `POST /search` | `{query, mode, limit, account, from, to, after, before}` → ranked results with per-engine ranks |
| `POST /ingest` | `{docs: [...]}` → embed + index; hash-unchanged docs skipped, folders merged |
| `POST /has` | which messages are already indexed (catch-up fast path) |
| `POST /delete` | remove messages (account_id + message_id pairs) |
| `POST /folders/remove` | drop one folder from a message's folder list |
| `POST /reconcile` | diff server index against the live set; fix drift, report missing |
| `POST /clear` | drop the whole index |
| `GET /health`, `GET /stats`, `GET /accounts`, `GET /version` | status |

All requests take `X-API-Key` when `api.api_key` is set in the config.

## Configuration

See [`config.example.yaml`](config.example.yaml). Key points:

- `qdrant.collection` defaults to `ai_omnisearch` (fresh — does not collide with
  an upstream thunderbird-ai-search "emails" collection; different point-id scheme)
- `database.path` holds the keyword index + content hashes (SQLite, FTS5)
- `search.keyword_weights` — bm25 column weights: subject, from, to, body
- `search.rrf_k` — Reciprocal Rank Fusion constant (60 = standard)

Changing the embedding model requires clearing the index (dimension mismatch)
and rebuilding.

## Privacy & security

- Everything stays on your machine: mail bodies go from Thunderbird to the local
  server, which calls only your Ollama and your Qdrant.
- Encrypted mail (OpenPGP/S-MIME) is indexed by subject/sender only, by default.
  Opting in to indexing decrypted bodies sends plaintext to the server and stores
  it unencrypted in its index (SQLite + Qdrant payloads) — same exposure class as
  omnisearch's opt-in.
- The add-on requests only `http://localhost/*` as a host permission; running the
  server on another host requires editing `addon/manifest.json`.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -r server/requirements.txt -r server/requirements-dev.txt
.venv/bin/python -m pytest server/tests -q   # 53 tests, no external services needed
./build.sh --dev                              # development .xpi with branch+sha
```

The test suite runs Qdrant in `:memory:` mode and uses a deterministic
bag-of-words fake embedder, so it needs no running services.

## Credits

- **[giovi321/thunderbird-ai-search](https://github.com/giovi321/thunderbird-ai-search)** (MIT) —
  server skeleton, FastAPI app, Ollama embedding provider (with input-bisecting
  error handling), Qdrant wrapper, add-on UI. Its IMAP indexer was replaced.
- **[CR0CKER/thunderbird-omnisearch](https://github.com/CR0CKER/thunderbird-omnisearch)** (MIT) —
  the mail-reading side: folder walking, body extraction across cores, event
  wiring, watermark catch-up, reconcile, and stable Message-ID-based opening
  (their docs/adr/0001 on why numeric ids silently go wrong is required reading).

## License

MIT — see [LICENSE](LICENSE).
