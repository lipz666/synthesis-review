"""Catalog access and dataset bundle loading, including path sanitisation.

Nothing in here knows what `tse.dataset.v1` means -- the field-level translation
happens in the browser (``static/js/adapters/``). This module is deliberately
schema-agnostic so a new extraction format only needs a new frontend adapter.
"""

from __future__ import annotations

import json
import math
import re
import threading
from pathlib import Path
from typing import Any

from . import storage
from .config import settings

# ---------------------------------------------------------------- catalog

_catalog_lock = threading.Lock()
_catalog_cache: dict[str, Any] = {"mtime": None, "value": None}


def load_catalog(force: bool = False) -> dict[str, Any]:
    path = settings.catalog_path
    if not path.is_file():
        return {"schema_version": "review.catalog.v1", "datasets": [], "error": f"catalog not found: {path}"}
    mtime = path.stat().st_mtime
    with _catalog_lock:
        if force or _catalog_cache["mtime"] != mtime:
            _catalog_cache["value"] = json.loads(path.read_text(encoding="utf-8"))
            _catalog_cache["mtime"] = mtime
        return _catalog_cache["value"]


def catalog_entry(dataset_id: str) -> dict[str, Any] | None:
    for entry in load_catalog().get("datasets", []):
        if entry.get("dataset_id") == dataset_id:
            return entry
    return None


def resolve_revision(dataset_id: str, revision: str | None = None) -> str | None:
    entry = catalog_entry(dataset_id)
    if entry is None:
        return None
    if revision is None or revision == "current":
        return entry.get("revision")
    if revision in entry.get("available_revisions", [entry.get("revision")]):
        return revision
    return None


# ------------------------------------------------------- path sanitisation

# Only values under these keys are treated as paths. Restricting by key keeps
# the walker away from SMILES, which legitimately contain '/' and '\'.
_PATH_KEY = re.compile(r"(^|_)(path|file|dir|renders|image|thumbnail|model_version)($|_)", re.I)
_ABS_WINDOWS = re.compile(r"[A-Za-z]:[\\/]")
_ASSET_ROOTS = ("pages", "schemes", "molecule_crops", "moldet", "report", "evidence", "data")


def _dataset_relative(value: str) -> str | None:
    """Return the workspace-relative tail of a path, or None if it has none.

    Works regardless of where the file used to live: the pipeline writes
    absolute paths into the JSON, and after ingestion the same file sits under a
    different root. Matching on the asset-root segment survives the move.
    """
    parts = [part for part in re.split(r"[\\/]+", value) if part]
    for index in range(len(parts) - 1, -1, -1):
        if parts[index] in _ASSET_ROOTS and index < len(parts) - 1:
            return "/".join(parts[index:])
    return None


def _mask(value: str) -> str:
    """Server-side path that must not reach a browser -> keep only the name."""
    name = re.split(r"[\\/]+", value)[-1]
    return f"local:{name}"


def sanitise(node: Any, dataset_id: str, revision: str, key: str | None = None) -> Any:
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        private = False
        parent_is_path = bool(key and _PATH_KEY.search(key))
        for child_key, child in node.items():
            # A container whose own key is path-like ({"renders": {"150": "pages/..."}})
            # passes that key down, otherwise the numeric child key hides the paths.
            effective = child_key if _PATH_KEY.search(str(child_key)) else (key if parent_is_path else child_key)
            value = sanitise(child, dataset_id, revision, effective)
            if value is _PRIVATE:
                out[child_key] = None
                private = True
            else:
                out[child_key] = value
        if private:
            out["_private_source"] = True
        return out
    if isinstance(node, list):
        items = [sanitise(item, dataset_id, revision, key) for item in node]
        return [None if item is _PRIVATE else item for item in items]
    if isinstance(node, str) and key and _PATH_KEY.search(key):
        relative = _dataset_relative(node)
        if relative and storage.exists(dataset_id, revision, relative):
            return storage.asset_url(dataset_id, revision, relative)
        if _ABS_WINDOWS.search(node) or node.startswith("/") or node.startswith("\\\\"):
            # Outside the published dataset: the original PDF, a fixture from
            # another workspace, a weights file on the extraction box.
            if key.endswith("file_path") or key == "path":
                return _PRIVATE
            return _mask(node)
    return node


class _Private:
    """Sentinel: this value pointed outside the dataset and must be dropped."""


_PRIVATE = _Private()


# ----------------------------------------------------------------- bundle

_bundle_lock = threading.Lock()
_bundles: dict[tuple[str, str], dict[str, Any]] = {}


def _page_index(paper: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten pages so the evidence viewer can size overlays without image headers.

    Page pixel size is derived from the PDF point size: px = pt * dpi / 72.
    """
    pages: list[dict[str, Any]] = []
    for document in paper.get("documents", []) or []:
        for page in document.get("pages", []) or []:
            renders = {}
            for dpi, url in (page.get("renders") or {}).items():
                try:
                    dpi_int = int(dpi)
                except (TypeError, ValueError):
                    continue
                if isinstance(url, str) and url:
                    renders[dpi_int] = {
                        "url": url,
                        # ceil, to match the renderer's own pixel size
                        "width_px": math.ceil(float(page.get("width_pt") or 0) * dpi_int / 72),
                        "height_px": math.ceil(float(page.get("height_pt") or 0) * dpi_int / 72),
                    }
            pages.append(
                {
                    "document_id": page.get("document_id") or document.get("document_id"),
                    "page": page.get("page"),
                    "width_pt": page.get("width_pt"),
                    "height_pt": page.get("height_pt"),
                    "has_text_layer": page.get("has_text_layer"),
                    "text_length": len(page.get("text") or ""),
                    "renders": renders,
                }
            )
    return pages


def _moldet(dataset_id: str, revision: str) -> dict[str, Any]:
    """Detection boxes per scheme, for the 'where on the scheme' overlay."""
    out: dict[str, Any] = {}
    try:
        root = storage.dataset_dir(dataset_id, revision) / "moldet"
    except storage.AssetNotFound:
        return out
    if not root.is_dir():
        return out
    for detections in sorted(root.glob("*/detections.json")):
        scheme_id = detections.parent.name
        try:
            raw = json.loads(detections.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        out[scheme_id] = sanitise(raw, dataset_id, revision)
    return out


def load_bundle(dataset_id: str, revision: str) -> dict[str, Any]:
    key = (dataset_id, revision)
    with _bundle_lock:
        cached = _bundles.get(key)
    if cached is not None:
        return cached

    dataset = storage.read_json(dataset_id, revision, "data/dataset.json")
    review_queue = storage.try_read_json(dataset_id, revision, "data/review_queue.json", {"items": []})
    candidates = storage.try_read_json(dataset_id, revision, "data/alignment_candidates.json", [])
    entry = catalog_entry(dataset_id) or {}

    dataset = sanitise(dataset, dataset_id, revision)
    review_queue = sanitise(review_queue, dataset_id, revision)

    assets = dict(entry.get("urls", {}))
    for name, relative in (
        ("route_svg", "report/route.svg"),
        ("extraction_summary", "report/extraction_summary.md"),
        ("scheme_overlay", "moldet"),
    ):
        if name not in assets and relative != "moldet" and storage.exists(dataset_id, revision, relative):
            assets[name] = storage.asset_url(dataset_id, revision, relative)

    bundle = {
        "dataset_id": dataset_id,
        "revision": revision,
        "schema_version": dataset.get("schema_version", "unknown"),
        "catalog": {k: v for k, v in entry.items() if k not in ("files",)},
        "dataset": dataset,
        "review_queue": review_queue,
        "alignment_candidates": sanitise(candidates, dataset_id, revision),
        "pages": _page_index(dataset.get("paper", {})),
        "moldet": _moldet(dataset_id, revision),
        "assets": assets,
    }
    with _bundle_lock:
        _bundles[key] = bundle
    return bundle


def invalidate() -> None:
    with _bundle_lock:
        _bundles.clear()
    load_catalog(force=True)


def entity_index(bundle: dict[str, Any]) -> dict[str, set[str]]:
    """Which uids exist, so ad-hoc review items can be validated server-side."""
    dataset = bundle["dataset"]
    return {
        "compound": {c.get("compound_uid") for c in dataset.get("compounds", [])},
        "reaction": {r.get("reaction_uid") for r in dataset.get("reactions", [])},
        "alignment": {a.get("alignment_uid") for a in dataset.get("alignments", [])},
        "evidence": {e.get("evidence_id") for e in dataset.get("evidence", [])},
        "issue": {i.get("issue_uid") for i in dataset.get("issues", [])},
        "dataset": {bundle["dataset_id"]},
    }
