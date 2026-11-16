#!/usr/bin/env python3
"""Import a JSONL export into a Qdrant collection and create the index schema.

Paired with tools/qdrant_export.py. Written for the 1.15 -> 1.20 move, where
the collection has to be recreated because 1.20 refuses the old `rocks_db`
payload-index config. Vectors are carried across untouched — nothing is
re-embedded.

Creates:
  - dense vector space (size detected from the data, Cosine)
  - keyword index on `account`, integer index on `date_ms`   (exact filters)
  - BM25-scored text indexes on subject / from / to / body   (keyword search)
  - `content_hash` on every payload, recomputed from the payload when absent
    (it used to live only in the server's SQLite; without it the first
    catch-up would treat all 100k messages as new and re-embed them)

    python tools/qdrant_import.py --collection ai_omnisearch --in ai.jsonl
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request


def call(base, path, body=None, method="POST", headers=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code, "body": e.read().decode("utf-8", "replace")}


def embed_text(p) -> str:
    """Must match server/ingest.py build_embed_text (and the add-on's copy)."""
    return (
        f"From: {p.get('from', '')}\nTo: {p.get('to', '')}\n"
        f"Subject: {p.get('subject', '')}\nDate: {p.get('date', '')}\n\n"
        f"{p.get('body', '')}"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:6333")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--in", dest="infile", required=True)
    ap.add_argument("--api-key", default="")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--recreate", action="store_true")
    ap.add_argument("--tokenizer", default="word", choices=["word", "prefix", "whitespace"])
    args = ap.parse_args()

    headers = {"api-key": args.api_key} if args.api_key else {}

    # One pass to learn the vector size, then stream again for the upserts.
    dims = 0
    total = 0
    with open(args.infile, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            point = json.loads(line)
            total += 1
            if not dims and point.get("vector"):
                dims = len(point["vector"])
    if not dims:
        raise SystemExit("no vectors found in the export")
    print(f"{total} points, {dims} dims")

    existing = call(args.url, f"/collections/{args.collection}", method="GET", headers=headers)
    if "__http_error__" not in existing:
        if not args.recreate:
            raise SystemExit(
                f"collection {args.collection!r} already exists (use --recreate)"
            )
        print("dropping existing collection")
        call(args.url, f"/collections/{args.collection}", method="DELETE", headers=headers)

    print("creating collection")
    print(
        call(
            args.url,
            f"/collections/{args.collection}",
            {"vectors": {"size": dims, "distance": "Cosine"}, "on_disk_payload": True},
            method="PUT",
            headers=headers,
        )
    )

    for field, schema in [
        ("account", {"type": "keyword"}),
        ("date_ms", {"type": "integer"}),
    ]:
        print(field, call(args.url, f"/collections/{args.collection}/index?wait=true",
                          {"field_name": field, "field_schema": schema}, method="PUT", headers=headers))

    for field in ("subject", "from", "to", "body"):
        print(field, call(args.url, f"/collections/{args.collection}/index?wait=true",
                          {"field_name": field,
                           "field_schema": {"type": "text", "tokenizer": args.tokenizer,
                                            "lowercase": True,
                                            "scoring": {"type": "bm25"}}},
                          method="PUT", headers=headers))

    started = time.time()
    batch, written, hashed = [], 0, 0
    def flush(force=False):
        nonlocal batch, written, hashed
        if not batch or (not force and len(batch) < args.batch):
            return
        res = call(args.url, f"/collections/{args.collection}/points?wait=false",
                   {"points": batch}, method="PUT", headers=headers)
        if "__http_error__" in res:
            raise SystemExit(f"upsert failed: {res}")
        written += len(batch)
        batch = []
        print(f"  {written}/{total} ({time.time() - started:.0f}s)", flush=True)

    with open(args.infile, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            p = json.loads(line)
            payload = p.get("payload") or {}
            if not payload.get("content_hash"):
                payload["content_hash"] = hashlib.sha256(
                    embed_text(payload).encode("utf-8", "ignore")
                ).hexdigest()
                hashed += 1
            batch.append({"id": p["id"], "vector": p["vector"], "payload": payload})
            flush()
    flush(True)

    # wait=true is per-batch; give the queue a moment to drain, then report the
    # settled count (indexing 100k points continues in the background).
    count = 0
    for _ in range(60):
        count = call(args.url, f"/collections/{args.collection}/points/count",
                     {"exact": True}, headers=headers)["result"]["count"]
        if count >= written:
            break
        time.sleep(2)
    print(f"imported {written} points, {hashed} content hashes computed, count now {count}")
    if count != total:
        print(f"WARNING: count {count} != exported {total}", file=sys.stderr)


if __name__ == "__main__":
    main()
