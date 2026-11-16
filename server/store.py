"""SQLite document store: the source of truth for what is indexed.

Qdrant holds the semantic vectors; this store holds:

- the keyword index (SQLite FTS5) used by keyword and hybrid search,
- the content hash per message that makes re-ingestion cheap (unchanged
  messages are never re-embedded),
- the folder list per message, merged across the folders a message
  appears in (Gmail labels / copies), and
- a numeric-id cache hint so the add-on can fast-path opening a result.

Point IDs in Qdrant are derived deterministically from (account_id,
message_id), so the docs table and the vector collection are kept in
lockstep by the ingest/delete/reconcile paths in server/ingest.py.
"""

import json
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    date_ms INTEGER NOT NULL DEFAULT 0,
    account_name TEXT NOT NULL DEFAULT '',
    folders TEXT NOT NULL DEFAULT '[]',
    snippet TEXT NOT NULL DEFAULT '',
    header_only INTEGER NOT NULL DEFAULT 0,
    encrypted INTEGER NOT NULL DEFAULT 0,
    numeric_id INTEGER,
    indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(account_id, message_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    subject, from_addr, to_addr, body,
    tokenize='unicode61 remove_diacritics 2'
);
"""


def escape_like(value: str) -> str:
    """Escape a LIKE pattern so % _ \ match literally."""
    return (
        value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )


class KeywordFilters:
    """Filters applied to both engines at search time."""

    def __init__(
        self,
        account_id: Optional[str] = None,
        from_contains: Optional[str] = None,
        to_contains: Optional[str] = None,
        after_ms: Optional[int] = None,
        before_ms: Optional[int] = None,
    ):
        self.account_id = account_id
        self.from_contains = from_contains
        self.to_contains = to_contains
        self.after_ms = after_ms
        self.before_ms = before_ms

    @property
    def any(self) -> bool:
        return any(
            v is not None
            for v in (
                self.account_id,
                self.from_contains,
                self.to_contains,
                self.after_ms,
                self.before_ms,
            )
        )


def match_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "message_id": row["message_id"],
        "account": row["account_id"],
        "account_name": row["account_name"],
        "subject": row["subject"],
        "from": row["from_addr"],
        "to": row["to_addr"],
        "date": row["date"],
        "date_ms": row["date_ms"],
        "folders": json.loads(row["folders"]),
        "snippet": row["snippet"],
        "header_only": bool(row["header_only"]),
        "encrypted": bool(row["encrypted"]),
        "numeric_id": row["numeric_id"],
    }


class DocStore:
    """SQLite-backed document store + FTS5 keyword index."""

    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.commit()

    # ---- single-row reads ----

    def get(self, account_id: str, message_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM docs WHERE account_id = ? AND message_id = ?",
                (account_id, message_id),
            ).fetchone()
        return dict(row) if row else None

    def get_many(self, keys: list[tuple[str, str]]) -> dict[tuple[str, str], dict]:
        """Batch lookup by (account_id, message_id)."""
        out: dict[tuple[str, str], dict] = {}
        with self._lock:
            for i in range(0, len(keys), 200):
                chunk = keys[i : i + 200]
                if not chunk:
                    continue
                placeholders = ",".join(["(?, ?)"] * len(chunk))
                args: list[Any] = []
                for a, m in chunk:
                    args.extend([a, m])
                rows = self._conn.execute(
                    f"SELECT * FROM docs WHERE (account_id, message_id) IN ({placeholders})",
                    args,
                ).fetchall()
                for row in rows:
                    out[(row["account_id"], row["message_id"])] = dict(row)
        return out

    # ---- writes ----

    def upsert_doc(
        self,
        *,
        account_id: str,
        message_id: str,
        content_hash: str,
        subject: str,
        from_addr: str,
        to_addr: str,
        date: str,
        date_ms: int,
        account_name: str,
        folders: list[str],
        snippet: str,
        header_only: bool,
        encrypted: bool,
        numeric_id: Optional[int],
    ) -> int:
        """Insert or replace the docs row. Returns the rowid."""
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO docs (
                    account_id, message_id, content_hash, subject, from_addr,
                    to_addr, date, date_ms, account_name, folders, snippet,
                    header_only, encrypted, numeric_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id, message_id) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    subject = excluded.subject,
                    from_addr = excluded.from_addr,
                    to_addr = excluded.to_addr,
                    date = excluded.date,
                    date_ms = excluded.date_ms,
                    account_name = excluded.account_name,
                    folders = excluded.folders,
                    snippet = excluded.snippet,
                    header_only = excluded.header_only,
                    encrypted = excluded.encrypted,
                    numeric_id = excluded.numeric_id
                """,
                (
                    account_id, message_id, content_hash, subject, from_addr,
                    to_addr, date, date_ms, account_name, json.dumps(folders),
                    snippet, int(header_only), int(encrypted), numeric_id,
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid or 0)

    def fts_upsert(
        self,
        rowid: int,
        subject: str,
        from_addr: str,
        to_addr: str,
        body: str,
    ) -> None:
        """Replace the FTS row for a docs rowid."""
        with self._lock:
            self._conn.execute("DELETE FROM docs_fts WHERE rowid = ?", (rowid,))
            self._conn.execute(
                "INSERT INTO docs_fts (rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)",
                (rowid, subject, from_addr, to_addr, body),
            )
            self._conn.commit()

    def set_folders(self, account_id: str, message_id: str, folders: list[str]) -> None:
        """Update only the folder list (no content change → no re-embed)."""
        with self._lock:
            self._conn.execute(
                "UPDATE docs SET folders = ? WHERE account_id = ? AND message_id = ?",
                (json.dumps(folders), account_id, message_id),
            )
            self._conn.commit()

    def remove_folder(
        self, account_id: str, message_id: str, folder: str
    ) -> tuple[str, list[str]]:
        """Drop one folder from a message's folder list.

        Returns ("deleted", []) when the last folder went (the caller must
        delete the Qdrant point too), or ("updated", remaining_folders).
        Returns ("missing", []) when the row is unknown.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT rowid, folders FROM docs WHERE account_id = ? AND message_id = ?",
                (account_id, message_id),
            ).fetchone()
            if row is None:
                return ("missing", [])
            folders = [f for f in json.loads(row["folders"]) if f != folder]
            if not folders:
                self._conn.execute(
                    "DELETE FROM docs WHERE rowid = ?", (row["rowid"],)
                )
                self._conn.execute(
                    "DELETE FROM docs_fts WHERE rowid = ?", (row["rowid"],)
                )
                self._conn.commit()
                return ("deleted", [])
            self._conn.execute(
                "UPDATE docs SET folders = ? WHERE rowid = ?",
                (json.dumps(folders), row["rowid"]),
            )
            self._conn.commit()
            return ("updated", folders)

    def delete_many(self, keys: list[tuple[str, str]]) -> int:
        """Delete docs + FTS rows for (account_id, message_id) pairs."""
        if not keys:
            return 0
        deleted = 0
        with self._lock:
            for i in range(0, len(keys), 200):
                chunk = keys[i : i + 200]
                placeholders = ",".join(["(?, ?)"] * len(chunk))
                args: list[Any] = []
                for a, m in chunk:
                    args.extend([a, m])
                rows = self._conn.execute(
                    f"SELECT rowid FROM docs WHERE (account_id, message_id) IN ({placeholders})",
                    args,
                ).fetchall()
                for row in rows:
                    self._conn.execute(
                        "DELETE FROM docs_fts WHERE rowid = ?", (row["rowid"],)
                    )
                self._conn.execute(
                    f"DELETE FROM docs WHERE (account_id, message_id) IN ({placeholders})",
                    args,
                )
                deleted += len(rows)
            self._conn.commit()
        return deleted

    # ---- keyword search ----

    def search_keyword(
        self,
        match: str,
        filters: KeywordFilters,
        limit: int,
        weights: list[float],
    ) -> list[dict]:
        """Ranked keyword search over FTS5 with bm25 column weighting.

        bm25() returns lower-is-better (negative) scores; ORDER BY ascending
        puts the best match first. The returned `bm25_score` is negated so
        that higher = better everywhere else in the codebase.
        """
        if not match:
            return []
        w = (weights + [1.0] * 4)[:4]
        sql = f"""
            SELECT d.*, bm25(docs_fts, :w0, :w1, :w2, :w3) AS raw_score
            FROM docs_fts
            JOIN docs d ON d.rowid = docs_fts.rowid
            WHERE docs_fts MATCH :match
        """
        params: dict[str, Any] = {
            "match": match,
            "limit": limit,
            "w0": w[0],
            "w1": w[1],
            "w2": w[2],
            "w3": w[3],
        }
        if filters.account_id is not None:
            sql += " AND d.account_id = :account_id"
            params["account_id"] = filters.account_id
        if filters.from_contains is not None:
            sql += " AND d.from_addr LIKE '%' || :from_q || '%' ESCAPE '\\'"
            params["from_q"] = escape_like(filters.from_contains)
        if filters.to_contains is not None:
            sql += " AND d.to_addr LIKE '%' || :to_q || '%' ESCAPE '\\'"
            params["to_q"] = escape_like(filters.to_contains)
        if filters.after_ms is not None:
            sql += " AND d.date_ms >= :after_ms"
            params["after_ms"] = filters.after_ms
        if filters.before_ms is not None:
            sql += " AND d.date_ms < :before_ms"
            params["before_ms"] = filters.before_ms
        sql += " ORDER BY raw_score LIMIT :limit"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        results = []
        for row in rows:
            record = match_record(row)
            record["bm25_score"] = -row["raw_score"]  # higher = better
            results.append(record)
        return results

    # ---- bulk / stats ----

    def all_keys(self) -> list[tuple[str, str, list[str]]]:
        """Every (account_id, message_id, folders) — for reconcile diffs."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT account_id, message_id, folders FROM docs"
            ).fetchall()
        return [
            (r["account_id"], r["message_id"], json.loads(r["folders"]))
            for r in rows
        ]

    def count(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()
        return int(row["n"])

    def accounts(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT account_id, MAX(account_name) AS account_name,
                       COUNT(*) AS count,
                       MAX(indexed_at) AS last_indexed_at,
                       SUM(header_only) AS header_only,
                       SUM(encrypted) AS encrypted
                FROM docs GROUP BY account_id ORDER BY count DESC
                """
            ).fetchall()
        return [
            {
                "account_id": r["account_id"],
                "name": r["account_name"] or r["account_id"],
                "count": int(r["count"]),
                "last_indexed_at": r["last_indexed_at"],
                "header_only": int(r["header_only"] or 0),
                "encrypted": int(r["encrypted"] or 0),
            }
            for r in rows
        ]

    def stats(self) -> dict:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(header_only) AS header_only,
                       SUM(encrypted) AS encrypted,
                       MIN(date_ms) AS oldest_ms,
                       MAX(date_ms) AS newest_ms
                FROM docs
                """
            ).fetchone()
        return {
            "total": int(row["total"] or 0),
            "header_only": int(row["header_only"] or 0),
            "encrypted": int(row["encrypted"] or 0),
            "oldest_ms": row["oldest_ms"],
            "newest_ms": row["newest_ms"],
        }

    def clear(self) -> None:
        """Wipe docs + FTS (the Qdrant collection is dropped separately)."""
        with self._lock:
            self._conn.executescript(
                "DELETE FROM docs_fts; DELETE FROM docs;"
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
