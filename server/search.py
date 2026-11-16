"""Hybrid search: keyword (SQLite FTS5 + bm25) + semantic (Qdrant + Ollama).

Three modes:

- ``keyword``  — bm25 ranking with column weights (subject > from > to > body)
                 and prefix matching ("invo" finds "invoice"). No embedding
                 involved, so it works even when Ollama is down.
- ``semantic`` — cosine similarity over Ollama embeddings in Qdrant (upstream
                 thunderbird-ai-search behaviour).
- ``hybrid``   — both engines queried, results fused with Reciprocal Rank
                 Fusion: a document at rank i (1-based) in an engine's list
                 contributes 1 / (k + i) to its fused score, summed across
                 engines. k = 60 (the standard value, Cormack et al. 2009).
                 RRF needs only ranks, so the two engines' incomparable raw
                 scores (cosine vs bm25) never get mixed.
"""

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from pydantic import BaseModel, Field

from server.embeddings import EmbeddingProvider
from server.store import DocStore, KeywordFilters
from server.vector_store import VectorStore

logger = logging.getLogger(__name__)

VALID_MODES = ("hybrid", "semantic", "keyword")

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)
_MAX_TOKENS = 32


class SearchRequest(BaseModel):
    query: str
    mode: str = "hybrid"
    limit: int = Field(default=10, ge=1, le=100)
    account: Optional[str] = None  # account_id (exact)
    from_filter: Optional[str] = Field(default=None, alias="from")
    to_filter: Optional[str] = Field(default=None, alias="to")
    after: Optional[str] = None  # ISO date or datetime, inclusive
    before: Optional[str] = None  # ISO date or datetime, inclusive

    model_config = {"populate_by_name": True}


class SemanticUnavailable(Exception):
    """The embedding service failed, so semantic search cannot run."""


def tokenize_query(query: str) -> list[str]:
    return _TOKEN_RE.findall(query)[:_MAX_TOKENS]


def fts_match_string(query: str) -> str:
    """FTS5 MATCH expression: every token as a quoted prefix term, OR-ed.

    "invo big" -> '"invo"* OR "big"*' — prefix matching like OmniSearch's
    search-as-you-type, and OR semantics like MiniSearch: a doc matching only
    some tokens still matches, ranked below docs matching the important ones
    (bm25 weights rare terms and the subject/from/to columns higher).
    """
    tokens = tokenize_query(query)
    return " OR ".join(f'"{t.replace(chr(34), chr(34) * 2)}"*' for t in tokens)


def parse_bound(value: str, end: bool) -> int:
    """ISO date/datetime -> epoch ms. Date-only values mean the whole local day."""
    try:
        if len(value) == 10:  # YYYY-MM-DD
            dt = datetime.fromisoformat(value)
            if end:
                dt += timedelta(days=1)
            return int(dt.timestamp() * 1000)
        dt = datetime.fromisoformat(value)
        return int(dt.timestamp() * 1000)
    except ValueError as e:
        raise ValueError(f"Invalid date filter '{value}': {e}") from e


def rrf_fuse(
    rankings: dict[str, list[tuple[Any, float]]],
    k: int,
) -> tuple[list[tuple[Any, float]], dict]:
    """Fuse ranked lists with Reciprocal Rank Fusion.

    Keys may be any hashable (tests use strings, the search service uses
    (account_id, message_id) tuples). Returns (ordered [(key, fused_score)],
    per-key {engine: (rank, score)}).
    """
    fused: dict[tuple[str, str], float] = {}
    engine_ranks: dict[tuple[str, str], dict[str, tuple[int, float]]] = {}
    for engine, ranking in rankings.items():
        for i, (key, score) in enumerate(ranking):
            rank = i + 1
            fused[key] = fused.get(key, 0.0) + 1.0 / (k + rank)
            engine_ranks.setdefault(key, {})[engine] = (rank, score)
    ordered = sorted(fused.items(), key=lambda kv: (-kv[1], kv[0]))
    return ordered, engine_ranks


class SearchService:
    def __init__(
        self,
        config,
        embedder: EmbeddingProvider,
        store: VectorStore,
        docstore: DocStore,
    ):
        self.config = config
        self.embedder = embedder
        self.store = store
        self.docstore = docstore

    async def search(self, req: SearchRequest) -> dict[str, Any]:
        if req.mode not in VALID_MODES:
            raise ValueError(f"mode must be one of {VALID_MODES}, got '{req.mode}'")
        query = req.query.strip()
        if not query:
            return self._empty(req)

        filters = KeywordFilters(
            account_id=req.account,
            from_contains=req.from_filter or None,
            to_contains=req.to_filter or None,
            after_ms=parse_bound(req.after, end=False) if req.after else None,
            before_ms=parse_bound(req.before, end=True) if req.before else None,
        )

        candidates = min(100, req.limit * max(1, self.config.search.candidates_multiplier))

        # ---- keyword engine ----
        keyword_hits: list[dict] = []
        if req.mode != "semantic":
            match = fts_match_string(query)
            keyword_hits = self.docstore.search_keyword(
                match, filters, candidates, self.config.search.keyword_weights
            )

        # ---- semantic engine ----
        semantic_hits: list[dict] = []
        semantic_available = True
        if req.mode != "keyword":
            try:
                vectors = await self.embedder.embed([query])
                vector = vectors[0] if vectors else None
                if vector is None:
                    raise RuntimeError("embedding service returned no vector")
            except Exception as e:
                if req.mode == "semantic":
                    raise SemanticUnavailable(str(e)) from e
                semantic_available = False  # hybrid: degrade to keyword-only
                logger.warning("Semantic engine unavailable, keyword-only: %s", e)
            else:
                semantic_hits = self.store.search(
                    vector, limit=candidates, account=req.account
                )
                semantic_hits = [h for h in semantic_hits if self._passes(h, filters)]

        mode_used = req.mode
        if req.mode == "hybrid" and not semantic_available:
            mode_used = "keyword (semantic unavailable)"

        # ---- assemble ----
        keyword_ranking = [
            ((h["account"], h["message_id"]), h["bm25_score"]) for h in keyword_hits
        ]
        semantic_ranking = [
            ((h["account"], h["message_id"]), h["score"]) for h in semantic_hits
        ]

        records: dict[tuple[str, str], dict] = {}
        for h in keyword_hits:  # already full records from the docs table
            records[(h["account"], h["message_id"])] = h
        sem_keys = [k for k, _ in semantic_ranking if k not in records]
        if sem_keys:
            for key, row in self.docstore.get_many(sem_keys).items():
                records[key] = self._record_from_row(row)
        for h in semantic_hits:  # payload fallback if the docs row is missing
            key = (h["account"], h["message_id"])
            if key not in records:
                records[key] = self._record_from_payload(h)

        results: list[dict] = []
        if req.mode == "hybrid":
            ordered, engine_ranks = rrf_fuse(
                {"semantic": semantic_ranking, "keyword": keyword_ranking},
                k=self.config.search.rrf_k,
            )
            for key, fused in ordered[: req.limit]:
                if key not in records:
                    continue
                results.append(
                    self._result(records[key], fused, engine_ranks.get(key, {}))
                )
        elif req.mode == "semantic":
            for rank, (key, score) in enumerate(semantic_ranking[: req.limit], start=1):
                if key in records:
                    results.append(
                        self._result(records[key], score, {"semantic": (rank, score)})
                    )
        else:  # keyword
            for rank, (key, score) in enumerate(keyword_ranking[: req.limit], start=1):
                if key in records:
                    results.append(
                        self._result(records[key], score, {"keyword": (rank, score)})
                    )

        return {
            "query": query,
            "mode": req.mode,
            "mode_used": mode_used,
            "results": results,
            "engines": {
                "semantic": {
                    "available": semantic_available,
                    "candidates": len(semantic_hits),
                },
                "keyword": {"candidates": len(keyword_hits)},
            },
        }

    # ---- helpers ----

    @staticmethod
    def _passes(hit: dict, filters: KeywordFilters) -> bool:
        """Post-filter semantic hits (payload values) by non-qdrant filters."""
        if filters.from_contains and filters.from_contains.lower() not in (
            hit.get("from") or ""
        ).lower():
            return False
        if filters.to_contains and filters.to_contains.lower() not in (
            hit.get("to") or ""
        ).lower():
            return False
        if filters.after_ms is not None and (hit.get("date_ms") or 0) < filters.after_ms:
            return False
        if filters.before_ms is not None and (hit.get("date_ms") or 0) >= filters.before_ms:
            return False
        return True

    @staticmethod
    def _record_from_row(row: dict) -> dict:
        import json as _json

        return {
            "message_id": row["message_id"],
            "account": row["account_id"],
            "account_name": row["account_name"],
            "subject": row["subject"],
            "from": row["from_addr"],
            "to": row["to_addr"],
            "date": row["date"],
            "date_ms": row["date_ms"],
            "folders": _json.loads(row["folders"]) if isinstance(row["folders"], str) else row["folders"],
            "snippet": row["snippet"],
            "header_only": bool(row["header_only"]),
            "encrypted": bool(row["encrypted"]),
            "numeric_id": row["numeric_id"],
        }

    @staticmethod
    def _record_from_payload(payload: dict) -> dict:
        return {
            "message_id": payload.get("message_id", ""),
            "account": payload.get("account", ""),
            "account_name": payload.get("account_name", ""),
            "subject": payload.get("subject", ""),
            "from": payload.get("from", ""),
            "to": payload.get("to", ""),
            "date": payload.get("date", ""),
            "date_ms": payload.get("date_ms", 0),
            "folders": payload.get("folders", []),
            "snippet": payload.get("snippet", ""),
            "header_only": payload.get("header_only", False),
            "encrypted": payload.get("encrypted", False),
            "numeric_id": payload.get("numeric_id"),
        }

    @staticmethod
    def _result(record: dict, score: float, engine_ranks: dict) -> dict:
        engines = {}
        for engine in ("semantic", "keyword"):
            if engine in engine_ranks:
                rank, raw = engine_ranks[engine]
                engines[engine] = {"rank": rank, "score": raw}
            else:
                engines[engine] = None
        result = dict(record)
        result["score"] = score
        result["engines"] = engines
        return result

    def _empty(self, req: SearchRequest) -> dict[str, Any]:
        return {
            "query": req.query,
            "mode": req.mode,
            "mode_used": req.mode,
            "results": [],
            "engines": {
                "semantic": {"available": True, "candidates": 0},
                "keyword": {"candidates": 0},
            },
        }
