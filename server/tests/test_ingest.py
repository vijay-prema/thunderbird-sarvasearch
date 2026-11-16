"""IngestService tests: dedup, folder merge, delete, reconcile."""

import json

import pytest

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


def test_reingest_refreshes_account_name_without_embed(services):
    # Everything indexed before the add-on carried account names has
    # account_name=''; a re-send of the same content with a name must
    # backfill it without re-embedding.
    ingest(services, services.make_doc(account_name=""))
    calls = services.embedder.calls
    r = ingest(services, services.make_doc(account_name="Work"))
    assert r["unchanged"] == 1
    assert services.embedder.calls == calls
    row = services.docstore.get("account1", "m1@example.com")
    assert row["account_name"] == "Work"


def test_attachments_stored_with_the_doc(services):
    ingest(services, services.make_doc(attachments=["invoice.pdf", "timesheet.xlsx"]))
    row = services.docstore.get("account1", "m1@example.com")
    assert json.loads(row["attachments"]) == ["invoice.pdf", "timesheet.xlsx"]
    payload = services.store.get_payloads([make_point_id("account1", "m1@example.com")])
    assert list(payload.values())[0]["attachments"] == ["invoice.pdf", "timesheet.xlsx"]


def test_attachments_backfill_without_embed(services):
    # A message indexed before attachment names were recorded carries none;
    # the next rebuild re-reads the MIME tree and must fill them in without
    # re-embedding (names are not part of the embed text).
    ingest(services, services.make_doc())
    calls = services.embedder.calls
    r = ingest(services, services.make_doc(attachments=["quotation.pdf"]))
    assert r["unchanged"] == 1
    assert services.embedder.calls == calls
    row = services.docstore.get("account1", "m1@example.com")
    assert json.loads(row["attachments"]) == ["quotation.pdf"]
    payload = services.store.get_payloads([make_point_id("account1", "m1@example.com")])
    assert list(payload.values())[0]["attachments"] == ["quotation.pdf"]


def test_header_only_read_does_not_erase_stored_names(services):
    # A read that could not see the MIME parts sends [] and header_only=True —
    # that must not wipe names an earlier read captured.
    ingest(services, services.make_doc(attachments=["contract.pdf"]))
    ingest(services, services.make_doc(attachments=[], header_only=True))
    row = services.docstore.get("account1", "m1@example.com")
    assert json.loads(row["attachments"]) == ["contract.pdf"]


def test_a_complete_read_clears_wrong_stored_names(services):
    # v2.4.0 labelled every message "ForwardedMessage.eml" (getFull's synthetic
    # message/rfc822 root was mistaken for a forwarded attachment). Only a
    # write that accepts [] on a complete read can undo that in an existing
    # index, so a rebuild repairs it without re-embedding.
    ingest(services, services.make_doc(attachments=["ForwardedMessage.eml"]))
    calls = services.embedder.calls
    r = ingest(services, services.make_doc(attachments=[]))  # body read: authoritative
    assert r["unchanged"] == 1
    assert services.embedder.calls == calls
    row = services.docstore.get("account1", "m1@example.com")
    assert json.loads(row["attachments"]) == []
    payload = services.store.get_payloads([make_point_id("account1", "m1@example.com")])
    assert list(payload.values())[0]["attachments"] == []


def test_payload_update_survives_a_keyword_only_message(services):
    # Mail Ollama refused to embed lives in FTS only — it has no Qdrant point.
    # Folder merges and attachment backfills must not blow up on it (local
    # Qdrant raises KeyError for an unknown point id).
    doc = services.make_doc(body="zzzrejectzzz")
    services.embedder.reject.add(
        f"From: {doc['from']}\nTo: {doc['to']}\nSubject: {doc['subject']}\n"
        f"Date: {doc['date']}\n\n{doc['body']}"
    )
    r = ingest(services, doc)
    assert r["embed_failed"] == 1
    assert services.store.count() == 0  # no point to update

    r = ingest(services, services.make_doc(body="zzzrejectzzz", folder="Archive"))
    assert r["folders_added"] == 1

    r = ingest(
        services,
        services.make_doc(body="zzzrejectzzz", folder="Archive", attachments=["moved.pdf"]),
    )
    assert r["unchanged"] == 1
    row = services.docstore.get("account1", "m1@example.com")
    assert json.loads(row["attachments"]) == ["moved.pdf"]


def test_lone_surrogates_are_repaired_before_storing(services):
    # Thunderbird's MIME decoding (and a body cut mid-emoji) can hand over half
    # of a surrogate pair. UTF-8 cannot encode it, so the Qdrant payload's JSON
    # and the SQLite write both raise — one message failed a whole rebuild.
    bad = "\ud83d"  # half of 😀
    doc = services.make_doc(
        mid="broken@x.com",
        subject=f"Party {bad} invite",
        body=f"Hey {bad} see you there",
        attachments=[f"photo{bad}.jpg"],
    )
    r = ingest(services, doc)
    assert r["indexed"] == 1 and r["failed"] == 0

    row = services.docstore.get("account1", "broken@x.com")
    assert row is not None
    assert "\ud83d" not in row["subject"]
    assert "\ufffd" in row["subject"]
    assert "\ufffd" in json.loads(row["attachments"])[0]
    # The stored text must be encodable, which is what Qdrant's JSON needs.
    row["subject"].encode("utf-8")
    row["snippet"].encode("utf-8")

    payload = services.store.get_payloads([make_point_id("account1", "broken@x.com")])
    body = list(payload.values())[0]["body"]
    body.encode("utf-8")  # would raise UnicodeEncodeError before the fix
    assert "\ud83d" not in body

    # A repaired body must hash to what is stored, so the next pass is a no-op
    # instead of an endless re-embed.
    calls = services.embedder.calls
    r = ingest(services, doc)
    assert r["unchanged"] == 1
    assert services.embedder.calls == calls


def test_one_bad_doc_does_not_abort_the_batch(services, monkeypatch):
    # A document the store cannot write is logged and skipped; the rest of the
    # batch still lands, so a rebuild never restarts at the same message.
    real = services.docstore.upsert_doc

    def flaky(**kwargs):
        if kwargs["message_id"] == "bad@x.com":
            raise RuntimeError("store rejected the payload")
        return real(**kwargs)

    monkeypatch.setattr(services.docstore, "upsert_doc", flaky)
    r = ingest(services, services.make_doc(mid="bad@x.com"), services.make_doc(mid="good@x.com"))
    assert r["failed"] == 1
    assert r["indexed"] == 1
    assert services.docstore.get("account1", "good@x.com") is not None


def test_every_doc_failing_still_raises(services, monkeypatch):
    # All docs failing means the store is down, not one poison message: the
    # request must fail so the add-on retries it.
    def always_broken(**kwargs):
        raise RuntimeError("qdrant is down")

    monkeypatch.setattr(services.docstore, "upsert_doc", always_broken)
    with pytest.raises(RuntimeError):
        ingest(services, services.make_doc(mid="a@x.com"), services.make_doc(mid="b@x.com"))


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
