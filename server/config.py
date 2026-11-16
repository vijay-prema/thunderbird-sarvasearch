"""Configuration loader for Thunderbird AI OmniSearch server.

The IMAP account configuration of upstream thunderbird-ai-search is gone:
mail is no longer pulled over IMAP by the server. The Thunderbird add-on
pushes already-downloaded mail to the server's /ingest endpoint instead.
"""

import logging
import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class OllamaConfig(BaseModel):
    base_url: str = "http://localhost:11434"
    model: str = "nomic-embed-text"


class QdrantConfig(BaseModel):
    url: str = "http://localhost:6333"
    # Fresh default name: does not collide with the "emails" collection of an
    # upstream thunderbird-ai-search install (different point-id scheme).
    collection: str = "ai_omnisearch"


class ApiConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8342
    api_key: str = ""


class DatabaseConfig(BaseModel):
    # SQLite database holding the keyword index (FTS5), content hashes and
    # folder lists. Qdrant holds the semantic vectors; this is the source of
    # truth for "what is indexed".
    path: str = "data/ingest.db"


class IngestConfig(BaseModel):
    # Hard cap on docs per /ingest request (HTTP 413 above this).
    max_batch: int = 250
    # Docs per Ollama /api/embed call when a batch needs embedding.
    embed_batch: int = 64


class SearchConfig(BaseModel):
    # Reciprocal Rank Fusion constant: a document at rank i (1-based) in an
    # engine's result list contributes 1 / (rrf_k + i) to its fused score.
    # 60 is the standard value from Cormack et al. (2009).
    rrf_k: int = 60
    # How many candidates to pull from each engine before fusing
    # (multiplied by the requested limit). More = better fusion, slower.
    candidates_multiplier: int = 3
    # FTS5 bm25 column weights, in column order: subject, from, to, body.
    # A subject match is worth 8x a body match; sender/recipient 4x/2x.
    keyword_weights: list[float] = Field(default_factory=lambda: [8.0, 4.0, 2.0, 1.0])


class AppConfig(BaseModel):
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    qdrant: QdrantConfig = Field(default_factory=QdrantConfig)
    api: ApiConfig = Field(default_factory=ApiConfig)
    database: DatabaseConfig = Field(default_factory=DatabaseConfig)
    ingest: IngestConfig = Field(default_factory=IngestConfig)
    search: SearchConfig = Field(default_factory=SearchConfig)
    log_level: str = "INFO"


_ENV_MAP = {
    "TAIS_QDRANT_URL": ("qdrant", "url"),
    "TAIS_QDRANT_COLLECTION": ("qdrant", "collection"),
    "TAIS_OLLAMA_BASE_URL": ("ollama", "base_url"),
    "TAIS_OLLAMA_MODEL": ("ollama", "model"),
    "TAIS_API_HOST": ("api", "host"),
    "TAIS_API_PORT": ("api", "port"),
    "TAIS_API_API_KEY": ("api", "api_key"),
    "TAIS_DATABASE_PATH": ("database", "path"),
    "TAIS_INGEST_MAX_BATCH": ("ingest", "max_batch"),
    "TAIS_INGEST_EMBED_BATCH": ("ingest", "embed_batch"),
    "TAIS_LOG_LEVEL": ("log_level",),
}


def _apply_env_overrides(config_dict: dict) -> dict:
    """Apply environment variable overrides with TAIS_ prefix."""
    for env_key, path in _ENV_MAP.items():
        val = os.environ.get(env_key)
        if val is None:
            continue
        d = config_dict
        for part in path[:-1]:
            if part not in d:
                d[part] = {}
            d = d[part]
        d[path[-1]] = val
    return config_dict


def load_config(path: Optional[str] = None) -> AppConfig:
    """Load configuration from YAML file with env var overrides."""
    config_path = Path(path) if path else Path("config.yaml")

    config_dict = {}
    if config_path.exists():
        with open(config_path) as f:
            config_dict = yaml.safe_load(f) or {}
        logger.info("Loaded config from %s", config_path)
    else:
        logger.warning("Config file %s not found, using defaults", config_path)

    config_dict = _apply_env_overrides(config_dict)
    return AppConfig(**config_dict)
