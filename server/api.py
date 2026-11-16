"""FastAPI application for Thunderbird AI OmniSearch server."""

import logging
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from server import __version__

logger = logging.getLogger(__name__)


class IngestRequest(BaseModel):
    docs: list[Any]  # validated as IngestDoc by the ingest service


class DeleteRequest(BaseModel):
    items: list[Any]


class FolderRemoveRequest(BaseModel):
    items: list[Any]


class ReconcileRequest(BaseModel):
    live: list[Any]


def create_app(lifespan=None) -> FastAPI:
    """Create the FastAPI app. Dependencies are attached via app.state after creation."""

    def check_api_key(x_api_key: Optional[str] = Header(None)) -> None:
        # app.state is set before any request can arrive (attached in main.py)
        required_key = app.state.config.api.api_key
        if required_key and x_api_key != required_key:
            raise HTTPException(status_code=401, detail="Invalid or missing API key")

    app = FastAPI(
        title="Thunderbird AI OmniSearch",
        version=__version__,
        lifespan=lifespan,
        dependencies=[Depends(check_api_key)],
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.post("/search")
    async def search(req: dict):
        from server.search import SearchRequest, SemanticUnavailable

        search_service = app.state.search_service
        try:
            request = SearchRequest(**req)
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        try:
            return await search_service.search(request)
        except SemanticUnavailable as e:
            raise HTTPException(
                status_code=502,
                detail=f"Embedding service failed, semantic search unavailable: {e}",
            ) from e
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    @app.post("/ingest")
    async def ingest(req: dict):
        from server.ingest import IngestDoc

        ingest_service = app.state.ingest_service
        raw = req.get("docs", [])
        max_batch = app.state.config.ingest.max_batch
        if len(raw) > max_batch:
            raise HTTPException(
                status_code=413,
                detail=f"Too many docs in one request: {len(raw)} > {max_batch}",
            )
        try:
            docs = [IngestDoc(**d) for d in raw]
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Invalid doc: {e}") from e
        try:
            return await ingest_service.ingest(docs)
        except Exception as e:
            logger.exception("Ingest failed")
            raise HTTPException(status_code=502, detail=f"Ingest failed: {e}") from e

    @app.post("/has")
    async def has(req: dict):
        from server.ingest import DeleteItem

        ingest_service = app.state.ingest_service
        try:
            items = [DeleteItem(**i) for i in req.get("items", [])]
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return {"known": ingest_service.has(items)}

    @app.post("/delete")
    async def delete(req: dict):
        from server.ingest import DeleteItem

        ingest_service = app.state.ingest_service
        try:
            items = [DeleteItem(**i) for i in req.get("items", [])]
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return {"deleted": ingest_service.delete(items)}

    @app.post("/folders/remove")
    async def folders_remove(req: dict):
        from server.ingest import FolderRemoveItem

        ingest_service = app.state.ingest_service
        try:
            items = [FolderRemoveItem(**i) for i in req.get("items", [])]
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return ingest_service.remove_folder(items)

    @app.post("/reconcile")
    async def reconcile(req: dict):
        from server.ingest import ReconcileItem

        ingest_service = app.state.ingest_service
        try:
            live = [ReconcileItem(**i) for i in req.get("live", [])]
        except Exception as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        return ingest_service.reconcile(live)

    @app.post("/clear")
    async def clear():
        app.state.ingest_service.clear()
        return {"status": "cleared"}

    @app.get("/version")
    async def version():
        return {"version": __version__}

    @app.get("/health")
    async def health():
        store = app.state.store
        embedder = app.state.embedder
        docstore = app.state.docstore

        qdrant_ok = store.is_healthy()
        ollama_ok = True
        try:
            await embedder.embed(["health check"])
        except Exception:
            ollama_ok = False
        sqlite_ok = True
        try:
            docstore.count()
        except Exception:
            sqlite_ok = False

        return {
            "qdrant": "ok" if qdrant_ok else "error",
            "ollama": "ok" if ollama_ok else "error",
            "sqlite": "ok" if sqlite_ok else "error",
        }

    @app.get("/stats")
    async def stats():
        docstore = app.state.docstore
        store = app.state.store
        snap = docstore.stats()
        return {
            "total_emails": snap["total"],
            "header_only": snap["header_only"],
            "encrypted": snap["encrypted"],
            "oldest_ms": snap["oldest_ms"],
            "newest_ms": snap["newest_ms"],
            "qdrant_points": store.count(),
            "accounts": docstore.accounts(),
        }

    @app.get("/accounts")
    async def accounts():
        return {"accounts": app.state.docstore.accounts()}

    return app
