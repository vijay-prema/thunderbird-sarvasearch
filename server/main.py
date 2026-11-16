"""Entry point for Thunderbird AI OmniSearch server.

No scheduler, no IMAP: mail arrives when the Thunderbird add-on pushes it
(via /ingest). Bring your own Ollama and Qdrant — they are expected to be
running already (docker or native).
"""

import asyncio
import logging
import os
import sys

import uvicorn

from server import __version__
from server.api import create_app
from server.config import load_config
from server.embeddings import OllamaEmbedding
from server.ingest import IngestService
from server.search import SearchService
from server.store import DocStore
from server.vector_store import VectorStore

logger = logging.getLogger("server")


def _config_path() -> str:
    env = os.environ.get("TAIS_CONFIG")
    if env:
        return env
    if os.path.exists("/app/config.yaml"):  # docker default
        return "/app/config.yaml"
    return "config.yaml"


def _detect_dimensions(embedder: OllamaEmbedding) -> int:
    """Known dims, or a one-off probe embedding to detect them."""
    try:
        return embedder.dimensions
    except RuntimeError:
        pass
    logger.info("Unknown embedding model dims, probing Ollama...")
    vectors = asyncio.run(embedder.embed(["dimension probe"]))
    for v in vectors:
        if v is not None:
            logger.info("Detected embedding dimensions: %d", len(v))
            return len(v)
    raise RuntimeError(
        "Could not detect embedding dimensions: Ollama returned no vector. "
        "Is the model pulled?"
    )


def main():
    config = load_config(_config_path())

    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    logger.info("Thunderbird AI OmniSearch server v%s starting", __version__)

    embedder = OllamaEmbedding(
        base_url=config.ollama.base_url,
        model=config.ollama.model,
    )
    store = VectorStore(
        url=config.qdrant.url,
        collection=config.qdrant.collection,
    )

    if not store.is_healthy():
        logger.error("Cannot connect to Qdrant at %s", config.qdrant.url)
        sys.exit(1)
    logger.info("Qdrant connection OK (%s)", config.qdrant.url)

    try:
        dimensions = _detect_dimensions(embedder)
        logger.info("Ollama connection OK (%s)", config.ollama.model)
    except Exception as e:
        logger.error("Cannot reach Ollama at %s: %s", config.ollama.base_url, e)
        logger.warning(
            "Server will start, but semantic search and embedding will fail "
            "until Ollama is available. Keyword search still works."
        )
        dimensions = 768  # nomic-embed-text default; collection only created later

    store.ensure_collection(dimensions=dimensions)

    docstore = DocStore(config.database.path)
    ingest_service = IngestService(config, embedder, store, docstore, dimensions=dimensions)
    search_service = SearchService(config, embedder, store, docstore)

    app = create_app()
    app.state.config = config
    app.state.embedder = embedder
    app.state.store = store
    app.state.docstore = docstore
    app.state.ingest_service = ingest_service
    app.state.search_service = search_service

    uvicorn.run(
        app,
        host=config.api.host,
        port=config.api.port,
        log_level=config.log_level.lower(),
    )


main()
