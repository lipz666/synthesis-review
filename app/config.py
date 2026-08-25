"""Runtime configuration. Everything comes from the environment, nothing is hard-coded.

The same image runs locally and in the cloud; only these variables change.
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _path(env: str, default: Path) -> Path:
    raw = os.environ.get(env)
    return Path(raw).resolve() if raw else default


def _list(env: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(env, default).split(",") if item.strip()]


class Settings:
    # Where the ingested datasets and the catalog live. Mount a volume here in
    # the cloud, or point it at a synced copy of an object-storage prefix.
    DATA_DIR: Path = _path("REVIEW_DATA_DIR", PROJECT_ROOT / "data")
    STATIC_DIR: Path = _path("REVIEW_STATIC_DIR", PROJECT_ROOT / "static")

    # Public URL prefix for dataset assets. Point it at a CDN/bucket to serve
    # images from somewhere other than this process.
    ASSET_URL_PREFIX: str = os.environ.get("REVIEW_ASSET_URL_PREFIX", "/review-data/datasets")

    # sqlite:///abs/path.sqlite3  (default)  |  postgresql://...  (see schema/events_postgres.sql)
    DATABASE_URL: str = os.environ.get("REVIEW_DATABASE_URL", "")

    # MVP identity: the browser sends a name, this is the fallback. Replace with
    # a real identity provider before exposing the app beyond a trusted network.
    DEFAULT_REVIEWER: str = os.environ.get("REVIEW_DEFAULT_REVIEWER", "anonymous")
    REQUIRE_REVIEWER: bool = os.environ.get("REVIEW_REQUIRE_REVIEWER", "0") == "1"

    # Split deployments (static on a CDN, API elsewhere) need this.
    CORS_ORIGINS: list[str] = _list("REVIEW_CORS_ORIGINS")

    ASSET_SUFFIXES: frozenset[str] = frozenset({".png", ".jpg", ".jpeg", ".svg", ".json", ".md", ".csv", ".txt"})
    ASSET_MAX_AGE: int = int(os.environ.get("REVIEW_ASSET_MAX_AGE", "86400"))

    # Above this size the bundle endpoint refuses to inline everything and the
    # frontend falls back to per-entity requests.
    BUNDLE_WARN_BYTES: int = int(os.environ.get("REVIEW_BUNDLE_WARN_BYTES", str(5 * 1024 * 1024)))

    VERSION: str = "0.1.0"

    @property
    def catalog_path(self) -> Path:
        return self.DATA_DIR / "catalog.json"

    @property
    def datasets_dir(self) -> Path:
        return self.DATA_DIR / "datasets"

    @property
    def database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        return f"sqlite:///{(self.DATA_DIR / 'review.sqlite3').as_posix()}"


settings = Settings()
