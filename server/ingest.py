"""Ingestion: turn docs pushed by the Thunderbird add-on into indexed records.

The add-on is the only mail reader. It walks the folders Thunderbird has
already downloaded and POSTs batches of documents to /ingest. This module:

- computes the embed text (same format as upstream thunderbird-ai-search) and
  a content hash, so unchanged messages are never re-embedded,
- merges folder lists: one message appearing in several folders (Gmail
  labels, copies) is ONE record listing all of them,
- fans each document out to Qdrant (semantic) and SQLite FTS5 (keyword), and
- implements delete / folder-remove / reconcile for the add-on's event
  listeners and "verify and repair" sweep.

Failure ordering: embed -> Qdrant upsert -> SQLite write. If Qdrant fails,
nothing is written and the doc is retried on the next catch-up pass. If
SQLite fails after Qdrant succeeded, the point is orphaned but the next pass
re-embeds it (wasteful, self-healing).
"""

import hashlib
import json
import logging
import re
import time
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator

from server.embeddings import EmbeddingProvider
from server.store import DocStore, load_json_list
from server.vector_store import VectorStore, make_point_id
from qdrant_client import models as qmodels

logger = logging.getLogger(__name__)

SNIPPET_LEN = 300

# Log one INFO summary line every N docs stored (new + updated), instead of
# a line per request — during a full index the requests never stop.
_LOG_EVERY = 500

# Any UTF-16 surrogate code point. Python decodes proper emoji to one code
# point (> U+FFFF), so a surrogate here is always half of a broken pair.
_SURROGATE = re.compile("[\ud800-\udfff]")


def clean_text(value: str) -> str:
    """Replace unpaired UTF-16 surrogates with U+FFFD.

    Thunderbird's MIME decoding (and a body cut mid-emoji) can hand us a lone
    half of a surrogate pair. UTF-8 cannot encode it, so the Qdrant payload's
    JSON and the SQLite write both raise — and one such message took down a
    whole ingest batch, and with it a whole rebuild job. Repair on the way in:
    the add-on normalises what it sends, this covers anything already in
    flight, an older add-on, or a hand-written ingest client.
    """
    return _SURROGATE.sub("\ufffd", value)


class IngestDoc(BaseModel):
    """One message as read by the add-on from Thunderbird's local store."""

    message_id: str  # RFC Message-ID, or 'local:<numeric id>' fallback
    account_id: str
    account_name: str = ""
    subject: str = ""
    from_: str = Field(default="", alias="from")
    to: str = ""
    date: str = ""  # ISO 8601
    date_ms: int = 0
    folder: str  # the folder this copy was read from
    body: str = ""
    snippet: str = ""
    numeric_id: Optional[int] = None  # Thunderbird's per-session id (open hint)
    header_only: bool = False  # body not downloaded
    encrypted: bool = False
    # File names of the message's attachments (names only, never content).
    attachments: list[str] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    @model_validator(mode="before")
    @classmethod
    def _repair_text(cls, data: Any) -> Any:
        """Normalise every incoming string before anything is hashed or stored.

        Runs before the content hash is computed, so a repaired body hashes to
        what is stored and a retry is stable (not a loop of "content changed").
        """
        if not isinstance(data, dict):
            return data
        cleaned: dict[str, Any] = {}
        for key, value in data.items():
            if isinstance(value, str):
                cleaned[key] = clean_text(value)
            elif isinstance(value, list):
                cleaned[key] = [
                    clean_text(item) if isinstance(item, str) else item
                    for item in value
                ]
            else:
                cleaned[key] = value
        return cleaned


class DeleteItem(BaseModel):
    account_id: str
    message_id: str


class FolderRemoveItem(DeleteItem):
    folder: str


class ReconcileItem(BaseModel):
    account_id: str
    message_id: str
    folders: list[str] = Field(default_factory=list)


def build_embed_text(doc: IngestDoc) -> str:
    """Same text format upstream embedded, so model behaviour carries over."""
    return (
        f"From: {doc.from_}\nTo: {doc.to}\nSubject: {doc.subject}\n"
        f"Date: {doc.date}\n\n{doc.body}"
    )


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()


class IngestService:
    def __init__(
        self,
        config,
        embedder: EmbeddingProvider,
        store: VectorStore,
        docstore: DocStore,
        dimensions: Optional[int] = None,
    ):
        self.config = config
        self.embedder = embedder
        self.store = store
        self.docstore = docstore
        self._dims = dimensions
        # Cumulative docs stored (indexed + updated), for the periodic
        # INFO summary — see _LOG_EVERY.
        self._stored_total = 0
        # Last /has heartbeat log time (monotonic) — see has().
        self._last_has_log = 0.0

    # ---- helpers ----

    def _payload(self, doc: IngestDoc, folders: list[str]) -> dict[str, Any]:
        return {
            "message_id": doc.message_id,
            "account": doc.account_id,
            "account_name": doc.account_name,
            "subject": doc.subject,
            "from": doc.from_,
            "to": doc.to,
            "date": doc.date,
            "date_ms": doc.date_ms,
            "folder": ", ".join(folders),
            "folders": folders,
            "snippet": doc.snippet or doc.body[:SNIPPET_LEN],
            "body": doc.body,
            "header_only": doc.header_only,
            "encrypted": doc.encrypted,
            "numeric_id": doc.numeric_id,
            "attachments": doc.attachments,
        }

    def _upsert_all(
        self,
        doc: IngestDoc,
        embed_text: str,
        chash: str,
        folders: list[str],
        vector: Optional[list[float]],
    ) -> None:
        """Write the doc everywhere. vector=None → keyword-only (embed failed)."""
        payload = self._payload(doc, folders)
        if vector is not None:
            self.store.upsert(
                [
                    qmodels.PointStruct(
                        id=make_point_id(doc.account_id, doc.message_id),
                        vector=vector,
                        payload=payload,
                    )
                ]
            )
        rowid = self.docstore.upsert_doc(
            account_id=doc.account_id,
            message_id=doc.message_id,
            content_hash=chash,
            subject=doc.subject,
            from_addr=doc.from_,
            to_addr=doc.to,
            date=doc.date,
            date_ms=doc.date_ms,
            account_name=doc.account_name,
            folders=folders,
            snippet=payload["snippet"],
            header_only=doc.header_only,
            encrypted=doc.encrypted,
            numeric_id=doc.numeric_id,
            attachments=doc.attachments,
        )
        self.docstore.fts_upsert(rowid, doc.subject, doc.from_, doc.to, doc.body)

    # ---- ingest ----

    async def ingest(self, docs: list[IngestDoc]) -> dict[str, int]:
        docs = list(docs)
        result = {
            "received": len(docs),
            "indexed": 0,       # newly embedded + stored
            "updated": 0,       # content changed → re-embedded
            "folders_added": 0,  # known content, new folder → merged, no embed
            "unchanged": 0,     # already indexed, nothing to do
            "embed_failed": 0,  # Ollama rejected the input (keyword-only now)
            "failed": 0,        # store rejected this doc; logged, retried later
        }

        existing = self.docstore.get_many(
            [(d.account_id, d.message_id) for d in docs]
        )

        embed_jobs: list[tuple[IngestDoc, str, str, list[str]]] = []
        for doc in docs:
            chash = content_hash(build_embed_text(doc))
            prior = existing.get((doc.account_id, doc.message_id))
            if prior is None:
                embed_jobs.append((doc, build_embed_text(doc), chash, [doc.folder]))
                continue
            prior_folders = json.loads(prior["folders"])
            if prior["content_hash"] == chash:
                # Content unchanged. Refresh the display name if the add-on
                # now sends one and the stored copy is empty/stale (indexed
                # before the add-on carried account names) — cheap, and a
                # rebuild backfills every existing row this way.
                if doc.account_name and doc.account_name != prior["account_name"]:
                    self.docstore.set_account_name(
                        doc.account_id, doc.message_id, doc.account_name
                    )
                # Attachment names are not part of the embed text, so a re-read
                # that finally sees them (schema added after the first index)
                # backfills them without re-embedding. A non-empty list always
                # came from a parsed MIME tree, so it can be written as is; an
                # empty one is only trustworthy when the read actually had a
                # body — a header-only or failed read sends [] because it could
                # not see the parts, which must not erase stored names. The
                # empty-and-authoritative case matters for repair: v2.4.0
                # mislabelled every message "ForwardedMessage.eml".
                prior_attachments = load_json_list(prior["attachments"])
                if doc.attachments != prior_attachments and (
                    doc.attachments or not doc.header_only
                ):
                    self.docstore.set_attachments(
                        doc.account_id, doc.message_id, doc.attachments
                    )
                    self.store.set_payload(
                        [make_point_id(doc.account_id, doc.message_id)],
                        {"attachments": doc.attachments},
                    )
                if doc.folder in prior_folders:
                    result["unchanged"] += 1
                else:
                    new_folders = sorted(set(prior_folders + [doc.folder]))
                    self.docstore.set_folders(doc.account_id, doc.message_id, new_folders)
                    self.store.set_payload(
                        [make_point_id(doc.account_id, doc.message_id)],
                        {"folders": new_folders, "folder": ", ".join(new_folders)},
                    )
                    result["folders_added"] += 1
            else:
                # Content changed (edited message): re-embed, keep folder union.
                folders = sorted(set(prior_folders + [doc.folder]))
                embed_jobs.append((doc, build_embed_text(doc), chash, folders))

        # Embed in chunks sized for one Ollama call each.
        batch = max(1, self.config.ingest.embed_batch)
        for i in range(0, len(embed_jobs), batch):
            chunk = embed_jobs[i : i + batch]
            texts = [text for (_doc, text, _h, _f) in chunk]
            try:
                vectors = await self.embedder.embed(texts)
            except Exception as e:
                logger.error("Embedding failed for batch of %d: %s", len(texts), e)
                raise
            chunk_failures = 0
            for (doc, _text, chash, folders), vector in zip(chunk, vectors):
                try:
                    if vector is None:
                        # Ollama rejected this single input. Store it keyword-only
                        # (FTS still finds it); the matching content hash means we
                        # do not retry it on every pass.
                        self._upsert_all(doc, _text, chash, folders, None)
                        result["embed_failed"] += 1
                    else:
                        self._upsert_all(doc, _text, chash, folders, vector)
                        if (doc.account_id, doc.message_id) in existing:
                            result["updated"] += 1
                        else:
                            result["indexed"] += 1
                except Exception as e:
                    # One unstorable message (a payload the store rejects) must
                    # not abort the batch and, with it, the whole rebuild — the
                    # run would restart from this same message every time.
                    # Log it with its identity, skip it, and keep going; the
                    # next pass retries it (nothing was recorded as stored).
                    result["failed"] += 1
                    chunk_failures += 1
                    logger.warning(
                        "ingest: skipping %s / %s (%r): %s",
                        doc.account_id, doc.message_id,
                        (doc.subject or "")[:60], e,
                    )
                    if chunk_failures == len(chunk):
                        # Every doc in this request failed the same way: that is
                        # the store being down, not one poison message.
                        raise

        prev = self._stored_total
        self._stored_total += result["indexed"] + result["updated"]
        logger.debug(
            "ingest: received=%d indexed=%d updated=%d folders_added=%d unchanged=%d embed_failed=%d failed=%d",
            result["received"], result["indexed"], result["updated"],
            result["folders_added"], result["unchanged"], result["embed_failed"],
            result["failed"],
        )
        if self._stored_total // _LOG_EVERY > prev // _LOG_EVERY:
            logger.info(
                "indexed %s messages total (last request: %d new, %d updated, %d folders merged)",
                f"{self._stored_total:,}", result["indexed"], result["updated"],
                result["folders_added"],
            )
        return result

    # ---- delete / folder ops ----

    def delete(self, items: list[DeleteItem]) -> int:
        keys = [(i.account_id, i.message_id) for i in items]
        self.store.delete([make_point_id(a, m) for a, m in keys])
        return self.docstore.delete_many(keys)

    def remove_folder(self, items: list[FolderRemoveItem]) -> dict[str, int]:
        result = {"deleted": 0, "updated": 0, "missing": 0}
        for item in items:
            status, folders = self.docstore.remove_folder(
                item.account_id, item.message_id, item.folder
            )
            if status == "deleted":
                self.store.delete([make_point_id(item.account_id, item.message_id)])
                result["deleted"] += 1
            elif status == "updated":
                self.store.set_payload(
                    [make_point_id(item.account_id, item.message_id)],
                    {"folders": folders, "folder": ", ".join(folders)},
                )
                result["updated"] += 1
            else:
                result["missing"] += 1
        return result

    # ---- reconcile ----

    def reconcile(self, live: list[ReconcileItem]) -> dict[str, Any]:
        """Diff the server's index against the add-on's view of all live mail.

        The add-on walks every folder and sends the full live set. The server:
        deletes records the add-on no longer sees, fixes folder drift, and
        returns the messages it is missing so the add-on can re-read them.
        """
        live_map = {
            (i.account_id, i.message_id): set(i.folders) for i in live
        }
        server_rows = self.docstore.all_keys()
        server_map = {
            (a, m): set(folders) for (a, m, folders) in server_rows
        }

        to_delete = [key for key in server_map if key not in live_map]
        folder_fixes = [
            key
            for key in server_map
            if key in live_map and server_map[key] != live_map[key]
        ]
        for key in folder_fixes:
            folders = sorted(live_map[key])
            self.docstore.set_folders(key[0], key[1], folders)
            self.store.set_payload(
                [make_point_id(*key)],
                {"folders": folders, "folder": ", ".join(folders)},
            )

        deleted = self.delete([DeleteItem(account_id=a, message_id=m) for a, m in to_delete])

        missing = [
            {"account_id": a, "message_id": m}
            for (a, m) in live_map
            if (a, m) not in server_map
        ]
        return {
            "deleted": deleted,
            "folders_updated": len(folder_fixes),
            "missing": missing,
        }

    # ---- bulk ----

    def has(self, items: list[DeleteItem]) -> list[dict[str, str]]:
        """Which of these (account_id, message_id) pairs are already indexed?

        Used by the add-on's catch-up pass to skip messages it already
        pushed, before paying for a body read. Logs a throttled heartbeat so
        a long skip-walk is visible in the (otherwise quiet) server log.
        """
        found = self.docstore.get_many(
            [(i.account_id, i.message_id) for i in items]
        )
        now = time.monotonic()
        if now - self._last_has_log > 30:
            self._last_has_log = now
            logger.info(
                "catch-up check: %d known of %d (%d new to read)",
                len(found), len(items), len(items) - len(found),
            )
        return [
            {"account_id": a, "message_id": m} for (a, m) in found
        ]

    def clear(self) -> None:
        """Drop and recreate both stores. Needs the embedding dimensions.

        Dimensions come from the constructor (main.py detects them at
        startup), else from the embedder's known-dims table.
        """
        dims = self._dims
        if dims is None:
            try:
                dims = self.embedder.dimensions
            except RuntimeError as e:
                raise RuntimeError(
                    "Cannot clear: embedding dimensions unknown (no probe at "
                    "startup and not a known model). Restart the server."
                ) from e
        self.store.clear(dimensions=dims)
        self.docstore.clear()
