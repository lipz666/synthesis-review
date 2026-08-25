"""Every filesystem read goes through here.

Swapping local disk for object storage means implementing ``read_bytes`` /
``exists`` against a bucket and returning signed URLs from ``asset_url``; no
other module touches paths.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import settings


class AssetNotFound(Exception):
    pass


class UnsafePath(Exception):
    pass


def dataset_dir(dataset_id: str, revision: str) -> Path:
    root = (settings.datasets_dir / dataset_id / revision).resolve()
    if not root.is_dir():
        raise AssetNotFound(f"{dataset_id}/{revision}")
    return root


def resolve(dataset_id: str, revision: str, relative: str) -> Path:
    """Resolve a dataset-relative path, refusing anything that escapes the root."""
    root = dataset_dir(dataset_id, revision)
    cleaned = relative.replace("\\", "/").lstrip("/")
    if not cleaned:
        raise UnsafePath("empty path")
    parts = [part for part in cleaned.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise UnsafePath(relative)
    candidate = (root / "/".join(parts)).resolve()
    # `resolve()` collapses symlinks too, so this catches link-based escapes.
    if not candidate.is_relative_to(root):
        raise UnsafePath(relative)
    if not candidate.is_file():
        raise AssetNotFound(relative)
    if candidate.suffix.lower() not in settings.ASSET_SUFFIXES:
        raise UnsafePath(f"suffix not allowed: {candidate.suffix}")
    return candidate


def read_json(dataset_id: str, revision: str, relative: str) -> Any:
    path = resolve(dataset_id, revision, relative)
    return json.loads(path.read_text(encoding="utf-8"))


def try_read_json(dataset_id: str, revision: str, relative: str, default: Any = None) -> Any:
    try:
        return read_json(dataset_id, revision, relative)
    except (AssetNotFound, UnsafePath, json.JSONDecodeError):
        return default


def exists(dataset_id: str, revision: str, relative: str) -> bool:
    try:
        resolve(dataset_id, revision, relative)
        return True
    except (AssetNotFound, UnsafePath):
        return False


def asset_url(dataset_id: str, revision: str, relative: str) -> str:
    clean = relative.replace("\\", "/").lstrip("/")
    return f"{settings.ASSET_URL_PREFIX.rstrip('/')}/{dataset_id}/{revision}/{clean}"
