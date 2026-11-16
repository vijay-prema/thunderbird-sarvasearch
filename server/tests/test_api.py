"""HTTP API tests through the FastAPI TestClient."""

import json

import pytest
from fastapi.testclient import TestClient

from server.api import create_app
from server.config import ApiConfig
from server.tests.conftest import FakeEmbedder, make_doc


def test_version(services):
    r = services.client.get("/version")
    assert r.status_code == 200
    assert r.json()["version"]


def test_health(services):
    r = services.client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["qdrant"] == "ok"
    assert body["ollama"] == "ok"
    assert body["sqlite"] == "ok"


def test_ingest_and_search_roundtrip(services):
    r = services.client.post("/ingest", json={"docs": [services.make_doc()]})
    assert r.status_code == 200
    assert r.json()["indexed"] == 1

    r = services.client.post("/search", json={"query": "invoice", "mode": "hybrid", "limit": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["mode_used"] == "hybrid"
    assert body["results"][0]["message_id"] == "m1@example.com"
    assert body["results"][0]["engines"]["keyword"]["rank"] == 1
    assert "body" not in body["results"][0]


def test_ingest_too_large_batch(services):
    services.config.ingest.max_batch = 2
    docs = [services.make_doc(mid=f"m{i}@x.com") for i in range(3)]
    r = services.client.post("/ingest", json={"docs": docs})
    assert r.status_code == 413


def test_ingest_invalid_doc(services):
    r = services.client.post("/ingest", json={"docs": [{"message_id": "x"}]})
    assert r.status_code == 422


def test_ingest_accepts_a_doc_with_a_lone_surrogate(services):
    # Reported failure: the add-on sent half an emoji, Qdrant's JSON encoder
    # raised UnicodeEncodeError, and the whole rebuild died with a 502.
    half = chr(0xD83D)
    doc = services.make_doc(
        mid="surrogate@x.com",
        subject="Party " + half + " invite",
        body="x" * 3985 + half + " see you there",
    )
    # httpx itself refuses to UTF-8-encode a lone surrogate, and a browser's
    # fetch() would already have replaced it — so send the raw JSON body, where
    # an ASCII \ud83d escape reaches the server as the same broken character an
    # older add-on put on the wire.
    payload = json.dumps({"docs": [doc]}).encode("ascii")
    r = services.client.post(
        "/ingest", content=payload, headers={"Content-Type": "application/json"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["indexed"] == 1
    # ... and the repaired text is what search hands back.
    r = services.client.post("/search", json={"query": "Party", "mode": "keyword"})
    assert r.status_code == 200
    subjects = [x["subject"] for x in r.json()["results"]]
    assert any("\ufffd" in s for s in subjects), subjects


def test_has_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    r = services.client.post("/has", json={
        "items": [
            {"account_id": "account1", "message_id": "m1@example.com"},
            {"account_id": "account1", "message_id": "nope@x.com"},
        ]
    })
    assert r.json()["known"] == [{"account_id": "account1", "message_id": "m1@example.com"}]


def test_delete_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    r = services.client.post("/delete", json={
        "items": [{"account_id": "account1", "message_id": "m1@example.com"}]
    })
    assert r.json()["deleted"] == 1
    assert services.docstore.count() == 0
    assert services.store.count() == 0


def test_folders_remove_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc(folder="Inbox")]})
    services.client.post("/ingest", json={"docs": [services.make_doc(folder="Archive")]})
    r = services.client.post("/folders/remove", json={
        "items": [{"account_id": "account1", "message_id": "m1@example.com", "folder": "Inbox"}]
    })
    assert r.json() == {"deleted": 0, "updated": 1, "missing": 0}


def test_reconcile_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc(mid="a@x.com")]})
    r = services.client.post("/reconcile", json={
        "live": [
            {"account_id": "account1", "message_id": "a@x.com", "folders": ["Inbox"]},
            {"account_id": "account1", "message_id": "b@x.com", "folders": ["Inbox"]},
        ]
    })
    body = r.json()
    assert body["deleted"] == 0
    assert body["missing"] == [{"account_id": "account1", "message_id": "b@x.com"}]


def test_clear_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    assert services.client.post("/clear").status_code == 200
    assert services.docstore.count() == 0
    assert services.store.count() == 0


def test_stats_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    body = services.client.get("/stats").json()
    assert body["total_emails"] == 1
    assert body["qdrant_points"] == 1
    assert body["accounts"][0]["account_id"] == "account1"


def test_accounts_endpoint(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    body = services.client.get("/accounts").json()
    assert body["accounts"][0]["name"] == "Work"


def test_api_key_required(tmp_path):
    from server.config import AppConfig, DatabaseConfig
    from server.ingest import IngestService
    from server.search import SearchService
    from server.store import DocStore
    from server.vector_store import VectorStore

    config = AppConfig(api=ApiConfig(api_key="sekrit"), database=DatabaseConfig(path=str(tmp_path / "t.db")))
    embedder = FakeEmbedder()
    store = VectorStore(url=":memory:", collection="test")
    docstore = DocStore(":memory:")
    store.ensure_collection(dimensions=embedder.dimensions)
    app = create_app()
    app.state.config = config
    app.state.embedder = embedder
    app.state.store = store
    app.state.docstore = docstore
    app.state.ingest_service = IngestService(config, embedder, store, docstore)
    app.state.search_service = SearchService(config, embedder, store, docstore)

    client = TestClient(app)
    assert client.get("/version").status_code == 401
    assert client.get("/version", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/version", headers={"X-API-Key": "sekrit"}).status_code == 200


def test_search_semantic_502_when_embedder_down(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    services.embedder.fail_all = True
    r = services.client.post("/search", json={"query": "invoice", "mode": "semantic"})
    assert r.status_code == 502
    services.embedder.fail_all = False


def test_search_hybrid_degrades_when_embedder_down(services):
    services.client.post("/ingest", json={"docs": [services.make_doc()]})
    services.embedder.fail_all = True
    r = services.client.post("/search", json={"query": "invoice", "mode": "hybrid"})
    assert r.status_code == 200
    assert r.json()["mode_used"] == "keyword (semantic unavailable)"
    services.embedder.fail_all = False
