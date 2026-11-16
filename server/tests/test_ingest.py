"""IngestService tests: dedup, folder merge, delete, reconcile."""

import json

from server.ingest import DeleteItem, FolderRemoveItem, IngestDoc, ReconcileItem
from server.store import KeywordFilters
from server.vector_store import make_point_id


def ingest(services, *docs):
    return services.run(services.ingest.ingest([IngestDoc(**d) for d in docs]))


def test_ingest_new_doc(services):
    r = ingest(services, services.make_doc())
    assert r["indexed"] == 1
    assert services.store.count() == 1  # qdrant point
    assert services.docstore.count() == 1  # docs row
    assert services.embedder.calls == 1


def test_reingest_same_doc_is_free(services):
    ingest(services, services.make_doc())
    calls = services.embedder.calls
    r = ingest(services, services.make_doc())
    assert r["unchanged"] == 1
    assert services.embedder.calls == calls  # no re-embed


def test_same_message_new_folder_merges_without_embed(services):
    ingest(services, services.make_doc(folder="Inbox"))
    calls = services.embedder.calls
    r = ingest(services, services.make_doc(folder="Archive"))
    assert r["folders_added"] == 1
    assert services.embedder.calls == calls
    row = services.docstore.get("account1", "m1@example.com")
    assert sorted(json.loads(row["folders"])) == ["Archive", "Inbox"]


def test_changed_body_reembeds(services):
    ingest(services, services.make_doc())
    calls = services.embedder.calls
    r = ingest(services, services.make_doc(body="Updated body: the invoice is now overdue."))
    assert r["updated"] == 1
    assert services.embedder.calls == calls + 1


def test_ollama_rejected_input_indexes_keyword_only(services):
    doc = services.make_doc(body="zzzrejectzzz")
    services.embedder.reject.add(
        f"From: {doc['from']}\nTo: {doc['to']}\nSubject: {doc['subject']}\n"
        f"Date: {doc['date']}\n\n{doc['body']}"
    )
    r = ingest(services, doc)
    assert r["embed_failed"] == 1
    assert services.store.count() == 0  # no vector point
    assert services.docstore.count() == 1  # but keyword row exists
    # keyword search still finds it
    hits = services.docstore.search_keyword(
        '"zzzrejectzzz"*', KeywordFilters(),
        10, [8.0, 4.0, 2.0, 1.0],
    )
    assert len(hits) == 1
    # and it is not retried on the next pass
    calls = services.embedder.calls
    r2 = ingest(services, doc)
    assert r2["unchanged"] == 1
    assert services.embedder.calls == calls


def test_delete(services):
    ingest(services, services.make_doc())
    assert services.ingest.delete([DeleteItem(account_id="account1", message_id="m1@example.com")]) == 1
    assert services.store.count() == 0
    assert services.docstore.count() == 0


def test_remove_folder_flows_to_delete(services):
    ingest(services, services.make_doc(folder="Inbox"))
    r = services.ingest.remove_folder(
        [FolderRemoveItem(account_id="account1", message_id="m1@example.com", folder="Inbox")]
    )
    assert r == {"deleted": 1, "updated": 0, "missing": 0}
    assert services.store.count() == 0


def test_remove_folder_keeps_message_in_other_folder(services):
    ingest(services, services.make_doc(folder="Inbox"))
    ingest(services, services.make_doc(folder="Archive"))
    r = services.ingest.remove_folder(
        [FolderRemoveItem(account_id="account1", message_id="m1@example.com", folder="Inbox")]
    )
    assert r == {"deleted": 0, "updated": 1, "missing": 0}
    assert services.store.count() == 1
    payload_point = services.store.get_payloads(
        [make_point_id("account1", "m1@example.com")]
    )
    payload = list(payload_point.values())[0]
    assert payload["folders"] == ["Archive"]


def test_reconcile(services):
    ingest(services, services.make_doc(mid="keep@x.com"))
    ingest(services, services.make_doc(mid="moved@x.com"))
    ingest(services, services.make_doc(mid="gone@x.com"))
    ingest(services, services.make_doc(mid="other-acct@x.com", account_id="account2"))

    live = [
        ReconcileItem(account_id="account1", message_id="keep@x.com", folders=["Inbox"]),
        ReconcileItem(account_id="account1", message_id="moved@x.com", folders=["Archive"]),
        ReconcileItem(account_id="account1", message_id="new@x.com", folders=["Inbox"]),
    ]
    r = services.ingest.reconcile(live)

    assert r["deleted"] == 2  # gone@x.com (dropped) + other-acct@x.com (whole account gone)
    assert r["folders_updated"] == 1  # moved@x.com Inbox -> Archive
    assert r["missing"] == [{"account_id": "account1", "message_id": "new@x.com"}]
    assert services.docstore.count() == 2
    import json

    assert json.loads(services.docstore.get("account1", "moved@x.com")["folders"]) == ["Archive"]


def test_has(services):
    ingest(services, services.make_doc())
    known = services.ingest.has([
        DeleteItem(account_id="account1", message_id="m1@example.com"),
        DeleteItem(account_id="account1", message_id="nope@x.com"),
    ])
    assert known == [{"account_id": "account1", "message_id": "m1@example.com"}]


def test_clear(services):
    ingest(services, services.make_doc())
    services.ingest.clear()
    assert services.store.count() == 0
    assert services.docstore.count() == 0
