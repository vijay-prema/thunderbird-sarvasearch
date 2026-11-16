"""DocStore (SQLite + FTS5) unit tests."""

import json

from server.store import DocStore, KeywordFilters, escape_like


def _put(store, mid, subject="", from_addr="", to_addr="", body="", account="account1",
         date_ms=1700000000000, folders=None):
    rowid = store.upsert_doc(
        account_id=account,
        message_id=mid,
        content_hash="h",
        subject=subject,
        from_addr=from_addr,
        to_addr=to_addr,
        date="2023-11-14T22:13:20.000Z",
        date_ms=date_ms,
        account_name="Work",
        folders=folders or ["Inbox"],
        snippet=body[:50],
        header_only=False,
        encrypted=False,
        numeric_id=1,
    )
    store.fts_upsert(rowid, subject, from_addr, to_addr, body)
    return rowid


def test_upsert_and_get(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", subject="Hello world")
    row = store.get("account1", "m1")
    assert row is not None
    assert row["subject"] == "Hello world"
    assert json.loads(row["folders"]) == ["Inbox"]
    assert store.get("account1", "missing") is None


def test_upsert_replaces_existing_row(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    r1 = _put(store, "m1", subject="one")
    r2 = _put(store, "m1", subject="two")
    assert r2 == r1  # same rowid, single row
    assert store.count() == 1
    assert store.get("account1", "m1")["subject"] == "two"


def test_fts_prefix_search(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", subject="Quarterly invoice attached", body="nothing here")
    hits = store.search_keyword('"invoi"*', KeywordFilters(), 10, [8.0, 4.0, 2.0, 1.0])
    assert len(hits) == 1
    assert hits[0]["message_id"] == "m1"


def test_fts_subject_match_beats_body_match(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "body-only", subject="Meeting notes", body="please review the invoice")
    _put(store, "subject-hit", subject="Invoice for plumbing", body="see attachment")
    hits = store.search_keyword('"invoice"*', KeywordFilters(), 10, [8.0, 4.0, 2.0, 1.0])
    assert [h["message_id"] for h in hits] == ["subject-hit", "body-only"]
    assert hits[0]["bm25_score"] > hits[1]["bm25_score"]


def test_fts_filters(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "a", subject="invoice", account="account1", from_addr="alice@corp.com", date_ms=1000)
    _put(store, "b", subject="invoice", account="account2", from_addr="bob@corp.com", date_ms=9000)
    _put(store, "c", subject="invoice", account="account1", from_addr="carol@corp.com", date_ms=5000)

    w = [8.0, 4.0, 2.0, 1.0]
    match = '"invoice"*'

    hits = store.search_keyword(match, KeywordFilters(account_id="account1"), 10, w)
    assert {h["message_id"] for h in hits} == {"a", "c"}

    hits = store.search_keyword(
        match, KeywordFilters(from_contains="alice"), 10, w
    )
    assert [h["message_id"] for h in hits] == ["a"]

    hits = store.search_keyword(
        match, KeywordFilters(after_ms=4000, before_ms=6000), 10, w
    )
    assert [h["message_id"] for h in hits] == ["c"]


def test_fts_like_escapes_wildcards(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "pct", subject="invoice", from_addr="weird%user@corp.com")
    _put(store, "plain", subject="invoice", from_addr="other@corp.com")
    hits = store.search_keyword(
        '"invoice"*', KeywordFilters(from_contains="%user"), 10, [8.0, 4.0, 2.0, 1.0]
    )
    assert [h["message_id"] for h in hits] == ["pct"]
    assert escape_like("a%b_c\\d") == "a\\%b\\_c\\\\d"


def test_remove_folder_last_deletes(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", folders=["Inbox"])
    status, remaining = store.remove_folder("account1", "m1", "Inbox")
    assert status == "deleted"
    assert remaining == []
    assert store.count() == 0


def test_remove_folder_keeps_others(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", folders=["Inbox", "Archive"])
    status, remaining = store.remove_folder("account1", "m1", "Inbox")
    assert status == "updated"
    assert remaining == ["Archive"]
    assert store.count() == 1


def test_set_folders(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", folders=["Inbox"])
    store.set_folders("account1", "m1", ["Archive", "Inbox"])
    assert json.loads(store.get("account1", "m1")["folders"]) == ["Archive", "Inbox"]


def test_delete_many(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1")
    _put(store, "m2")
    _put(store, "m3")
    assert store.delete_many([("account1", "m1"), ("account1", "m3"), ("account1", "nope")]) == 2
    assert store.count() == 1
    # FTS rows went too
    hits = store.search_keyword('"hello"*', KeywordFilters(), 10, [8.0] * 4)
    assert hits == []


def test_all_keys_and_stats(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1", folders=["Inbox"], account="account1")
    _put(store, "m2", folders=["Inbox", "Archive"], account="account2")
    keys = store.all_keys()
    assert ("account1", "m1", ["Inbox"]) in keys
    assert ("account2", "m2", ["Inbox", "Archive"]) in keys
    stats = store.stats()
    assert stats["total"] == 2
    accounts = {a["account_id"]: a for a in store.accounts()}
    assert accounts["account1"]["count"] == 1
    assert accounts["account2"]["count"] == 1


def test_clear(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1")
    store.clear()
    assert store.count() == 0


def test_attachments_roundtrip_and_preserve(tmp_path):
    store = DocStore(str(tmp_path / "s.db"))
    _put(store, "m1")
    store.set_attachments("account1", "m1", ["a.pdf", "b.xlsx"])
    row = store.get("account1", "m1")
    assert row is not None
    assert json.loads(row["attachments"]) == ["a.pdf", "b.xlsx"]
    # A re-upsert that says nothing about attachments keeps them.
    _put(store, "m1")
    row = store.get("account1", "m1")
    assert row is not None
    assert json.loads(row["attachments"]) == ["a.pdf", "b.xlsx"]
    # An explicit empty list replaces them.
    store.set_attachments("account1", "m1", [])
    row = store.get("account1", "m1")
    assert row is not None
    assert json.loads(row["attachments"]) == []


def test_migrates_a_database_from_before_attachments(tmp_path):
    import sqlite3

    path = str(tmp_path / "old.db")
    # The pre-attachments schema, with one row already in it.
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE docs (
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
        INSERT INTO docs (account_id, message_id, content_hash, subject)
        VALUES ('account1', 'old@x.com', 'h', 'Old message');
        """
    )
    conn.commit()
    conn.close()

    store = DocStore(path)  # opening adds the column
    row = store.get("account1", "old@x.com")
    assert row is not None
    assert row["subject"] == "Old message"
    assert json.loads(row["attachments"]) == []
    store.set_attachments("account1", "old@x.com", ["archived.pdf"])
    row = store.get("account1", "old@x.com")
    assert row is not None
    assert json.loads(row["attachments"]) == ["archived.pdf"]
