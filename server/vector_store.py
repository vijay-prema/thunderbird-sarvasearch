"""Qdrant vector store wrapper for Thunderbird AI OmniSearch.

Same role as upstream thunderbird-ai-search, with two changes:

- Point IDs are derived from (account_id, message_id) instead of the bare
  Message-ID, so the same Message-ID in two different accounts (you on both
  sides of a thread) stays two distinct, correctly-filterable points.
- Extra helpers: set_payload (folder-list updates without re-embedding) and
  clear (drop + recreate the collection).
"""

import logging
import uuid
from typing import Any, Optional

from qdrant_client import QdrantClient, models

logger = logging.getLogger(__name__)


def make_point_id(account_id: str, message_id: str) -> str:
    """Deterministic UUID from the (account_id, message_id) pair."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{account_id}|{message_id}"))


class VectorStore:
    """Thin wrapper around Qdrant for email vector storage."""

    def __init__(self, url: str = "http://localhost:6333", collection: str = "ai_omnisearch"):
        # A plain path (":memory:" or a file path) selects qdrant-client's
        # local mode — used by the test suite, no server needed.
        if url.startswith("http://") or url.startswith("https://"):
            self.client = QdrantClient(url=url)
        else:
            self.client = QdrantClient(location=url)
        self.collection = collection

    def ensure_collection(self, dimensions: int = 768) -> None:
        """Create the collection if it doesn't exist. Abort on dimension mismatch."""
        collections = self.client.get_collections().collections
        existing = [c for c in collections if c.name == self.collection]

        if existing:
            info = self.client.get_collection(self.collection)
            existing_dim = info.config.params.vectors.size
            if existing_dim != dimensions:
                logger.error(
                    "Collection '%s' exists with %d dimensions, expected %d. "
                    "Delete it manually or change the embedding model.",
                    self.collection, existing_dim, dimensions,
                )
                raise RuntimeError(
                    f"Dimension mismatch: collection has {existing_dim}, need {dimensions}"
                )
            logger.info("Collection '%s' already exists (%d dims)", self.collection, dimensions)
            return

        self.client.create_collection(
            collection_name=self.collection,
            vectors_config=models.VectorParams(
                size=dimensions,
                distance=models.Distance.COSINE,
            ),
        )
        # Create payload indices for filtering. Best-effort: qdrant-client's
        # local (in-memory) mode used by the test suite does not support all
        # index operations; on a real server these always succeed.
        for field, schema in [
            ("account", models.PayloadSchemaType.KEYWORD),
            ("date_ms", models.PayloadSchemaType.INTEGER),
        ]:
            try:
                self.client.create_payload_index(
                    collection_name=self.collection,
                    field_name=field,
                    field_schema=schema,
                )
            except Exception as e:  # pragma: no cover - local-mode only
                logger.warning("Could not create payload index on '%s': %s", field, e)
        logger.info("Created collection '%s' (%d dims, cosine)", self.collection, dimensions)

    def upsert(self, points: list[models.PointStruct]) -> None:
        """Batch upsert points into the collection."""
        if not points:
            return
        self.client.upsert(
            collection_name=self.collection,
            points=points,
            wait=True,
        )
        logger.debug("Upserted %d points", len(points))

    def set_payload(self, point_ids: list[str], payload: dict[str, Any]) -> None:
        """Update payload fields on existing points (no re-embedding)."""
        if not point_ids:
            return
        self.client.set_payload(
            collection_name=self.collection,
            payload=payload,
            points=point_ids,
            wait=True,
        )

    def search(
        self,
        vector: list[float],
        limit: int = 10,
        account: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Search for similar emails. Returns list of dicts with payload + score."""
        query_filter = None
        if account:
            query_filter = models.Filter(
                must=[
                    models.FieldCondition(
                        key="account",
                        match=models.MatchValue(value=account),
                    )
                ]
            )

        results = self.client.query_points(
            collection_name=self.collection,
            query=vector,
            query_filter=query_filter,
            limit=limit,
            with_payload=True,
        )

        return [
            {
                "id": str(point.id),
                "score": point.score,
                **(point.payload or {}),
            }
            for point in results.points
        ]

    def get_payloads(self, point_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Retrieve payloads by point ID (for repairs)."""
        if not point_ids:
            return {}
        results, _ = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=models.Filter(
                must=[models.HasIdCondition(has_id=point_ids)]
            ),
            limit=len(point_ids),
            with_payload=True,
            with_vectors=False,
        )
        return {str(r.id): dict(r.payload or {}) for r in results}

    def count(self, account: Optional[str] = None) -> int:
        """Count points in the collection, optionally filtered by account."""
        if account:
            result = self.client.count(
                collection_name=self.collection,
                count_filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="account",
                            match=models.MatchValue(value=account),
                        )
                    ]
                ),
                exact=True,
            )
            return result.count
        result = self.client.count(
            collection_name=self.collection,
            exact=True,
        )
        return result.count

    def delete(self, point_ids: list[str]) -> None:
        """Batch delete points by ID."""
        if not point_ids:
            return
        self.client.delete(
            collection_name=self.collection,
            points_selector=models.PointIdsList(points=point_ids),
            wait=True,
        )
        logger.debug("Deleted %d points", len(point_ids))

    def clear(self, dimensions: int) -> None:
        """Drop and recreate the collection."""
        try:
            self.client.delete_collection(self.collection)
            logger.info("Dropped collection '%s'", self.collection)
        except Exception:
            pass  # did not exist
        self.ensure_collection(dimensions=dimensions)

    def is_healthy(self) -> bool:
        """Check if Qdrant is reachable."""
        try:
            self.client.get_collections()
            return True
        except Exception:
            return False
