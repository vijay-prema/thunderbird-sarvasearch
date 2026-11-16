"""Shared fixtures: a deterministic fake embedder, in-memory stores, an app."""

import asyncio
import math
import re
import zlib
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from server.api import create_app
from server.config import AppConfig, ApiConfig, DatabaseConfig, IngestConfig, QdrantConfig, SearchConfig
from server.embeddings import EmbeddingProvider
from server.ingest import IngestService
from server.search import SearchService
from server.store import DocStore
from server.vector_store import VectorStore


class FakeEmbedder(EmbeddingProvider):
    """Deterministic bag-of-words embedding: texts sharing words land close.

    Rejected texts (self.reject) get None — simulating Ollama's per-input 400.
    fail_all=True raises — simulating Ollama being down.
    """

    DIMS = 64

    def __init__(self):
        self.calls = 0
        self.texts: list[str] = []
        self.reject: set[str] = set()
        self.fail_all = False

    @property
    def dimensions(self) -> int:
        return self.DIMS

    async def embed(self, texts):
        self.calls += 1
        self.texts.extend(texts)
        if self.fail_all:
            raise RuntimeError("embedding service down")
        return [None if t in self.reject else self._one(t) for t in texts]

    def _one(self, text):
        vec = [0.0] * self.DIMS
        # crc32, not hash(): hash() is salted per process, so the vector a
        # word maps to — and therefore every ranking assertion — changed
        # between runs (a flaky suite for no reason).
        for tok in re.findall(r"\w+", text.lower()):
            vec[zlib.crc32(tok.encode("utf-8")) % self.DIMS] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]

    async def close(self):
        pass


def make_doc(
    mid="m1@example.com",
    account_id="account1",
    account_name="Work",
    subject="Invoice for plumbing work",
    from_="alice@example.com",
    to="bob@example.com",
    body="Please pay the invoice for the plumbing work soon.",
    folder="Inbox",
    date_ms=1700000000000,
    **overrides,
):
    doc = {
        "message_id": mid,
        "account_id": account_id,
        "account_name": account_name,
        "subject": subject,
        "from": from_,
        "to": to,
        "date": "2023-11-14T22:13:20.000Z",
        "date_ms": date_ms,
        "folder": folder,
        "body": body,
        "snippet": body[:200],
        "numeric_id": 42,
        "header_only": False,
        "encrypted": False,
    }
    doc.update(overrides)
    return doc


@pytest.fixture
def services(tmp_path):
    config = AppConfig(
        api=ApiConfig(api_key=""),
        database=DatabaseConfig(path=str(tmp_path / "test.db")),
        qdrant=QdrantConfig(collection="test"),
        ingest=IngestConfig(max_batch=50, embed_batch=32),
        search=SearchConfig(),
    )
    embedder = FakeEmbedder()
    store = VectorStore(url=":memory:", collection="test")
    docstore = DocStore(":memory:")
    store.ensure_collection(dimensions=embedder.dimensions)
    ingest = IngestService(config, embedder, store, docstore, dimensions=embedder.dimensions)
    search = SearchService(config, embedder, store, docstore)

    app = create_app()
    app.state.config = config
    app.state.embedder = embedder
    app.state.store = store
    app.state.docstore = docstore
    app.state.ingest_service = ingest
    app.state.search_service = search

    return SimpleNamespace(
        config=config,
        embedder=embedder,
        store=store,
        docstore=docstore,
        ingest=ingest,
        search=search,
        app=app,
        client=TestClient(app),
        run=lambda coro: asyncio.run(coro),
        make_doc=make_doc,
    )
