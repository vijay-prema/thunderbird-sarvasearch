#!/usr/bin/env python3
"""Export one Qdrant collection to JSONL (id + vector + payload).

Why this exists: Qdrant 1.16+ dropped the `rocks_db` payload-index storage
backend, and a 1.15-era collection whose index config says `"rocks_db"` makes
1.20 refuse to load the shard (panic: "unknown variant `rocks_db`"). There is
no forward migration for that config, so the supported path is to carry the
data across: scroll it out (vectors included, so nothing is re-embedded) and
import it into a fresh collection on the new server.

    python tools/qdrant_export.py --collection ai_omnisearch --out ai.jsonl
    # ... start qdrant 1.20 on fresh storage ...
    python tools/qdrant_import.py --collection ai_omnisearch --in ai.jsonl

Resumable: rerun with --offset <n> (printed on every progress line) if it is
interrupted. Nothing is written to the source collection.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request


def post(base: str, path: str, body: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{path} failed: HTTP {e.code} {e.read()[:400]!r}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:6333")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--api-key", default="")
    ap.add_argument("--offset", type=int, default=0, help="resume from this count")
    ap.add_argument("--batch", type=int, default=256)
    args = ap.parse_args()

    headers = {"api-key": args.api_key} if args.api_key else {}
    offset = None if args.offset == 0 else args.offset
    written = args.offset
    mode = "a" if args.offset else "w"

    total = post(
        args.url,
        f"/collections/{args.collection}/points/count",
        {"exact": True},
        headers,
    )["result"]["count"]
    print(f"exporting {total} points", flush=True)

    with open(args.out, mode, encoding="utf-8") as fh:
        while True:
            body = {
                "limit": args.batch,
                "with_payload": True,
                "with_vector": True,
            }
            if offset is not None:
                body["offset"] = offset
            page = post(
                args.url,
                f"/collections/{args.collection}/points/scroll",
                body,
                headers,
            )["result"]
            points = page.get("points") or []
            for p in points:
                fh.write(
                    json.dumps(
                        {"id": p["id"], "vector": p["vector"], "payload": p["payload"]},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
            written += len(points)
            fh.flush()
            offset = page.get("next_page_offset")
            print(f"  {written}/{total} (resume offset {written})", flush=True)
            if not points or offset is None:
                break

    print(f"done: {written} points -> {args.out}", flush=True)
    if written != total:
        print(f"WARNING: wrote {written}, expected {total}", file=sys.stderr)


if __name__ == "__main__":
    main()
