"""Submission intake: validate a package, stage it, install it as a new revision.

Shared by the HTTP endpoints and by ``scripts/ingest_workspace.py`` so both
paths apply exactly the same rules. Nothing here trusts the submitter: archive
entries are checked for traversal, suffixes are allow-listed, sizes are capped,
and the payload is validated before a single byte lands in the data directory.

Install is atomic: everything is written to a staging directory first and only
then moved into ``datasets/{dataset_id}/{revision}/``, so a failed or aborted
submission can never leave a half-written dataset for a reviewer to open.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import verify
from .config import settings

# --------------------------------------------------------------- constants

SUBMISSION_FORMAT = "review.submission.v1"

#: The only file a package must contain.
REQUIRED_FILE = "data/dataset.json"

#: Files copied verbatim when present. Anything else in the package is ignored.
PACKAGE_FILES = (
    "data/dataset.json",
    "data/review_queue.json",
    "data/alignment_candidates.json",
    "data/database_rows.json",
    "data/compounds.json",
    "data/reactions.json",
    "data/alignments.json",
    "data/evidence.json",
    "data/route_graph.json",
    "data/issues.json",
    "data/validations.json",
    "data/paper.json",
    "data/procedures.json",
    "data/reactions.csv",
    "data/reaction_smiles.csv",
    "report/route.svg",
    "report/extraction_summary.md",
)

#: Directories whose contents are copied recursively.
ASSET_DIRS = ("pages", "schemes", "molecule_crops", "moldet", "evidence", "report")

#: Schemas the frontend has an adapter for. Others are accepted but flagged:
#: the data is stored, and the UI says "unsupported format" instead of guessing.
KNOWN_SCHEMAS = ("tse.dataset.v1",)

CONTRACTS = {
    "tse.dataset.v1": {"documentation": "DATA_CONTRACT_V1_ZH.md"},
    "synthlit.interchange.v1": {"documentation": "INTERCHANGE_CONTRACT_V1_ZH.md"},
}

DATASET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class SubmissionError(Exception):
    """Rejected before anything was written. ``report`` explains why."""

    def __init__(self, message: str, report: dict[str, Any] | None = None, status: int = 422):
        super().__init__(message)
        self.message = message
        self.report = report or {}
        self.status = status


# ------------------------------------------------------------------- spec


def submission_spec() -> dict[str, Any]:
    """Machine-readable description of the accepted package, served at /ingest/spec."""
    return {
        "format": SUBMISSION_FORMAT,
        "transports": [
            {
                "name": "zip",
                "method": "POST",
                "path": "/api/v1/ingest",
                "content_type": "application/zip",
                "body": "raw zip bytes (not multipart)",
                "query": {
                    "dataset_id": "optional; defaults to manifest.json or the archive's root folder",
                    "force": "re-install an already-present revision (default false)",
                    "dry_run": "validate only, write nothing (default false)",
                },
            },
            {
                "name": "json",
                "method": "POST",
                "path": "/api/v1/ingest/json",
                "content_type": "application/json",
                "body": {
                    "dataset_id": "string, required",
                    "dataset": "the extraction dataset object, required",
                    "review_queue": "object, optional",
                    "alignment_candidates": "array, optional",
                },
                "note": "no images; the UI degrades to SMILES-only views",
            },
        ],
        "headers": {
            "X-Api-Key": "required when REVIEW_INGEST_TOKEN is configured",
            "X-Submitted-By": "optional free-text provenance, stored in manifest.json",
        },
        "package_layout": {
            "required": [REQUIRED_FILE],
            "optional_files": [name for name in PACKAGE_FILES if name != REQUIRED_FILE],
            "optional_directories": list(ASSET_DIRS),
            "manifest": "manifest.json {dataset_id, source, notes} — optional",
            "note": "a single top-level folder is stripped automatically",
        },
        "dataset_requirements": {
            "schema_version": f"string, required; adapters exist for {list(KNOWN_SCHEMAS)}",
            "compounds[].compound_uid": "unique, required",
            "reactions[].reaction_uid": "unique, required",
            "reactions[].reactants/products": "compound_uid references, must resolve",
            "alignments[].reaction_uid": "must resolve",
            "evidence[].evidence_id": "unique",
            "review_queue.items[].review_item_uid": "unique",
        },
        "limits": {
            "max_upload_bytes": settings.INGEST_MAX_BYTES,
            "max_uncompressed_bytes": settings.INGEST_MAX_UNCOMPRESSED_BYTES,
            "max_entries": settings.INGEST_MAX_ENTRIES,
            "allowed_suffixes": sorted(settings.ASSET_SUFFIXES),
        },
        "revision": "sha256(dataset.json bytes + ':' + sha256(review_queue.json bytes))[:16]",
        "idempotency": "re-submitting identical bytes yields the same revision and is a no-op unless force=true",
    }


# --------------------------------------------------------------- helpers


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def compute_revision(dataset_bytes: bytes, queue_bytes: bytes | None) -> tuple[str, str, str | None]:
    """Same algorithm the extraction pipeline uses, so revisions agree end to end."""
    dataset_hash = _sha256_bytes(dataset_bytes)
    queue_hash = _sha256_bytes(queue_bytes) if queue_bytes is not None else None
    seed = f"{dataset_hash}:{queue_hash or ''}".encode()
    return hashlib.sha256(seed).hexdigest()[:16], dataset_hash, queue_hash


def _array(payload: dict[str, Any], key: str) -> list[Any]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _canonical_json(payload: Any) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n").encode("utf-8")


# ---------------------------------------------------------- validation


def validate_submission(
    dataset: Any,
    review_queue: Any = None,
    candidates: Any = None,
    present_files: set[str] | None = None,
) -> dict[str, Any]:
    """Structural and referential checks. Errors block; warnings do not."""
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(dataset, dict):
        raise SubmissionError("dataset must be a JSON object", {"errors": ["dataset is not an object"]})

    schema_version = dataset.get("schema_version")
    if not schema_version:
        errors.append("dataset.schema_version is missing")
    elif schema_version not in KNOWN_SCHEMAS:
        warnings.append(
            f"schema_version {schema_version!r} has no frontend adapter; "
            f"the dataset will be stored but shown as an unsupported format"
        )

    compounds = _array(dataset, "compounds")
    reactions = _array(dataset, "reactions")
    alignments = _array(dataset, "alignments")
    evidence = _array(dataset, "evidence")

    compound_uids: set[str] = set()
    for index, compound in enumerate(compounds):
        uid = (compound or {}).get("compound_uid")
        if not uid:
            errors.append(f"compounds[{index}] has no compound_uid")
        elif uid in compound_uids:
            errors.append(f"duplicate compound_uid: {uid}")
        else:
            compound_uids.add(uid)

    reaction_uids: set[str] = set()
    for index, reaction in enumerate(reactions):
        uid = (reaction or {}).get("reaction_uid")
        if not uid:
            errors.append(f"reactions[{index}] has no reaction_uid")
            continue
        if uid in reaction_uids:
            errors.append(f"duplicate reaction_uid: {uid}")
        reaction_uids.add(uid)
        for role in ("reactants", "products"):
            for participant in _array(reaction, role):
                if participant not in compound_uids:
                    errors.append(f"{uid}.{role} references unknown compound {participant}")
        if not _array(reaction, "reactants") and not _array(reaction, "products"):
            warnings.append(f"{uid} has no participants; the reaction page will be empty")

    evidence_ids: set[str] = set()
    for index, record in enumerate(evidence):
        eid = (record or {}).get("evidence_id")
        if not eid:
            errors.append(f"evidence[{index}] has no evidence_id")
        elif eid in evidence_ids:
            errors.append(f"duplicate evidence_id: {eid}")
        else:
            evidence_ids.add(eid)

    alignment_uids: set[str] = set()
    for index, alignment in enumerate(alignments):
        uid = (alignment or {}).get("alignment_uid")
        if not uid:
            errors.append(f"alignments[{index}] has no alignment_uid")
        elif uid in alignment_uids:
            errors.append(f"duplicate alignment_uid: {uid}")
        else:
            alignment_uids.add(uid)
        reaction_uid = (alignment or {}).get("reaction_uid")
        if reaction_uid and reaction_uid not in reaction_uids:
            errors.append(f"{uid or f'alignments[{index}]'} references unknown reaction {reaction_uid}")

    if isinstance(review_queue, dict):
        item_uids: set[str] = set()
        for index, item in enumerate(_array(review_queue, "items")):
            uid = (item or {}).get("review_item_uid")
            if not uid:
                errors.append(f"review_queue.items[{index}] has no review_item_uid")
            elif uid in item_uids:
                errors.append(f"duplicate review_item_uid: {uid}")
            else:
                item_uids.add(uid)
            if str(uid or "").startswith("ADHOC:"):
                errors.append(f"{uid}: the ADHOC: prefix is reserved for reviewer-initiated items")
    elif review_queue is not None:
        errors.append("review_queue must be a JSON object with an items array")

    if candidates is not None and not isinstance(candidates, list):
        errors.append("alignment_candidates must be an array")

    # Quoted paper text is re-checked here, at intake, so a submitter learns that
    # their character offsets do not line up before a reviewer wastes time on it.
    verified = verify.verify_all(dataset)
    unverified = [uid for uid, entry in verified.items() if not entry["verified"]]
    if unverified:
        warnings.append(
            f"{len(unverified)}/{len(verified)} alignments could not be re-checked against the page text "
            f"(first: {', '.join(unverified[:3])}); they will show as 未回查 in the UI"
        )

    missing_assets: list[str] = []
    if present_files is not None:
        for reference in _asset_references(dataset):
            if reference not in present_files:
                missing_assets.append(reference)
        if missing_assets:
            warnings.append(
                f"{len(missing_assets)} referenced image(s) are not in the package "
                f"(first: {', '.join(missing_assets[:3])}); those views fall back to placeholders"
            )

    if not compounds:
        warnings.append("no compounds in this dataset")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "schema_version": schema_version,
        "counts": {
            "compounds": len(compounds),
            "reactions": len(reactions),
            "alignments": len(alignments),
            "evidence": len(evidence),
            "issues": len(_array(dataset, "issues")),
            "validations": len(_array(dataset, "validations")),
            "review_items": len(_array(review_queue, "items")) if isinstance(review_queue, dict) else 0,
        },
        "source_verification": {
            "checked": len(verified),
            "verified": len(verified) - len(unverified),
            "unverified": unverified[:20],
        },
        "missing_assets": missing_assets[:20],
    }


def _asset_references(node: Any, key: str | None = None, out: set[str] | None = None) -> set[str]:
    """Package-relative image paths mentioned anywhere in the dataset."""
    if out is None:
        out = set()
    if isinstance(node, dict):
        for child_key, child in node.items():
            _asset_references(child, str(child_key), out)
    elif isinstance(node, list):
        for item in node:
            _asset_references(item, key, out)
    elif isinstance(node, str) and key and re.search(r"(path|renders|image)", key, re.I):
        parts = [part for part in re.split(r"[\\/]+", node) if part]
        for index in range(len(parts) - 1, -1, -1):
            if parts[index] in ASSET_DIRS and index < len(parts) - 1:
                out.add("/".join(parts[index:]))
                break
    return out


# ------------------------------------------------------------- staging


class Staged:
    """A validated package sitting in a temporary directory, ready to install."""

    def __init__(self, root: Path, dataset: dict[str, Any], review_queue: Any, candidates: Any,
                 files: int, size: int, dataset_id_hint: str | None, source: str | None):
        self.root = root
        self.dataset = dataset
        self.review_queue = review_queue
        self.candidates = candidates
        self.files = files
        self.size = size
        self.dataset_id_hint = dataset_id_hint
        self.source = source

    @property
    def revision(self) -> tuple[str, str, str | None]:
        dataset_bytes = (self.root / REQUIRED_FILE).read_bytes()
        queue_path = self.root / "data/review_queue.json"
        queue_bytes = queue_path.read_bytes() if queue_path.is_file() else None
        return compute_revision(dataset_bytes, queue_bytes)

    def present_files(self) -> set[str]:
        return {
            path.relative_to(self.root).as_posix()
            for path in self.root.rglob("*")
            if path.is_file()
        }


def _new_workdir() -> Path:
    root = settings.DATA_DIR / ".staging"
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="pkg-", dir=root))


def _strip_common_prefix(names: list[str]) -> str:
    """Zipping a workspace folder puts everything under it; drop that one level."""
    if any(name == REQUIRED_FILE for name in names):
        return ""
    roots = {name.split("/", 1)[0] for name in names if "/" in name}
    if len(roots) == 1:
        prefix = f"{roots.pop()}/"
        if any(name == f"{prefix}{REQUIRED_FILE}" for name in names):
            return prefix
    return ""


def stage_zip(raw: bytes, source: str | None = None) -> Staged:
    if len(raw) > settings.INGEST_MAX_BYTES:
        raise SubmissionError(
            f"package is {len(raw)} bytes, over the {settings.INGEST_MAX_BYTES} byte limit", status=413
        )
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise SubmissionError(f"not a readable zip archive: {exc}") from exc

    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > settings.INGEST_MAX_ENTRIES:
            raise SubmissionError(f"archive has {len(infos)} entries, over the limit", status=413)

        names = [info.filename.replace("\\", "/") for info in infos]
        prefix = _strip_common_prefix(names)
        workdir = _new_workdir()
        wanted = set(PACKAGE_FILES) | {"manifest.json"}
        written = 0
        total = 0
        ignored: list[str] = []

        try:
            for info, raw_name in zip(infos, names):
                name = raw_name[len(prefix):] if prefix and raw_name.startswith(prefix) else raw_name
                if not name:
                    continue
                parts = [part for part in name.split("/") if part not in ("", ".")]
                if not parts or ".." in parts or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                    raise SubmissionError(f"unsafe archive entry: {raw_name}", status=400)
                relative = "/".join(parts)
                keep = relative in wanted or parts[0] in ASSET_DIRS
                if not keep:
                    ignored.append(relative)
                    continue
                if Path(relative).suffix.lower() not in settings.ASSET_SUFFIXES:
                    ignored.append(relative)
                    continue
                total += info.file_size
                if total > settings.INGEST_MAX_UNCOMPRESSED_BYTES:
                    raise SubmissionError("archive expands past the uncompressed size limit", status=413)

                target = (workdir / relative).resolve()
                if not target.is_relative_to(workdir.resolve()):
                    raise SubmissionError(f"unsafe archive entry: {raw_name}", status=400)
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                written += 1

            dataset_path = workdir / REQUIRED_FILE
            if not dataset_path.is_file():
                raise SubmissionError(f"package has no {REQUIRED_FILE}")
            manifest = _read_json(workdir / "manifest.json") if (workdir / "manifest.json").is_file() else {}
            hint = manifest.get("dataset_id") or (prefix.rstrip("/") or None)

            return Staged(
                root=workdir,
                dataset=_read_json(dataset_path),
                review_queue=_optional_json(workdir / "data/review_queue.json"),
                candidates=_optional_json(workdir / "data/alignment_candidates.json"),
                files=written,
                size=total,
                dataset_id_hint=hint,
                source=source or manifest.get("source"),
            )
        except Exception:
            shutil.rmtree(workdir, ignore_errors=True)
            raise


def stage_json(payload: dict[str, Any], source: str | None = None) -> Staged:
    dataset = payload.get("dataset")
    if not isinstance(dataset, dict):
        raise SubmissionError("body.dataset must be the extraction dataset object")
    workdir = _new_workdir()
    try:
        (workdir / "data").mkdir(parents=True, exist_ok=True)
        dataset_bytes = _canonical_json(dataset)
        (workdir / REQUIRED_FILE).write_bytes(dataset_bytes)
        size = len(dataset_bytes)
        for key, relative in (
            ("review_queue", "data/review_queue.json"),
            ("alignment_candidates", "data/alignment_candidates.json"),
        ):
            if payload.get(key) is not None:
                blob = _canonical_json(payload[key])
                (workdir / relative).write_bytes(blob)
                size += len(blob)
        return Staged(
            root=workdir,
            dataset=dataset,
            review_queue=payload.get("review_queue"),
            candidates=payload.get("alignment_candidates"),
            files=1 + sum(1 for key in ("review_queue", "alignment_candidates") if payload.get(key) is not None),
            size=size,
            dataset_id_hint=payload.get("dataset_id"),
            source=source or payload.get("source"),
        )
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def stage_directory(workspace: Path, source: str | None = None) -> Staged:
    """CLI path: an extraction workspace already on disk."""
    dataset_path = workspace / REQUIRED_FILE
    if not dataset_path.is_file():
        raise SubmissionError(f"{dataset_path} not found -- is this an extraction workspace?")
    workdir = _new_workdir()
    seen: set[str] = set()
    total = 0
    try:
        def take(src: Path, name: str) -> None:
            nonlocal total
            # `report/` is listed both as named files and as an asset dir.
            if name in seen or not src.is_file():
                return
            target = workdir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            seen.add(name)
            total += src.stat().st_size

        for relative in PACKAGE_FILES:
            take(workspace / relative, relative)
        for directory in ASSET_DIRS:
            src_dir = workspace / directory
            if not src_dir.is_dir():
                continue
            for src in sorted(src_dir.rglob("*")):
                if src.is_file() and src.suffix.lower() in settings.ASSET_SUFFIXES:
                    take(src, src.relative_to(workspace).as_posix())
        return Staged(
            root=workdir,
            dataset=_read_json(workdir / REQUIRED_FILE),
            review_queue=_optional_json(workdir / "data/review_queue.json"),
            candidates=_optional_json(workdir / "data/alignment_candidates.json"),
            files=len(seen),
            size=total,
            dataset_id_hint=workspace.name,
            source=source or str(workspace),
        )
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def _optional_json(path: Path) -> Any:
    return _read_json(path) if path.is_file() else None


# ------------------------------------------------------------- install


def install(
    staged: Staged,
    dataset_id: str | None = None,
    force: bool = False,
    dry_run: bool = False,
    submitted_by: str | None = None,
) -> dict[str, Any]:
    """Validate, then move the staged package into place as a new revision."""
    try:
        resolved_id = (dataset_id or staged.dataset_id_hint
                       or staged.dataset.get("paper", {}).get("paper_id")
                       or staged.dataset.get("run", {}).get("paper_id"))
        if not resolved_id:
            raise SubmissionError("dataset_id could not be determined; pass ?dataset_id=")
        resolved_id = str(resolved_id)
        if not DATASET_ID_RE.match(resolved_id):
            raise SubmissionError(
                f"invalid dataset_id {resolved_id!r}: use letters, digits, dot, dash or underscore"
            )

        report = validate_submission(
            staged.dataset, staged.review_queue, staged.candidates, staged.present_files()
        )
        revision, dataset_hash, queue_hash = staged.revision
        report.update({
            "dataset_id": resolved_id,
            "revision": revision,
            "files": staged.files,
            "bytes": staged.size,
            "dry_run": dry_run,
        })

        if not report["ok"]:
            raise SubmissionError("submission failed validation", report)

        target = settings.datasets_dir / resolved_id / revision
        exists = (target / REQUIRED_FILE).is_file()
        report["already_present"] = exists

        if dry_run:
            report["installed"] = False
            return report

        if exists and not force:
            # Identical bytes produce an identical revision, so a repeated
            # submission is a no-op rather than an error.
            report["installed"] = False
            report["message"] = "this revision is already present; pass force=true to reinstall"
            report["catalog"] = catalog_entry_for(resolved_id)
            return report

        (staged.root / "manifest.json").write_text(
            json.dumps(
                {
                    "submission_format": SUBMISSION_FORMAT,
                    "dataset_id": resolved_id,
                    "revision": revision,
                    "ingested_at": datetime.now(timezone.utc).isoformat(),
                    "submitted_by": submitted_by,
                    "source": staged.source,
                    "integrity": {"dataset_sha256": dataset_hash, "review_queue_sha256": queue_hash},
                    "files": staged.files,
                    "bytes": staged.size,
                },
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )

        _atomic_install(staged.root, target)
        staged.root = target  # no longer a temp dir; skip cleanup

        catalog = rebuild_catalog()
        report["installed"] = True
        report["catalog"] = next(
            (entry for entry in catalog["datasets"] if entry["dataset_id"] == resolved_id), None
        )
        report["url"] = f"/#/?dataset={resolved_id}"
        return report
    finally:
        cleanup(staged)


def _atomic_install(source: Path, target: Path, attempts: int = 5) -> None:
    """Move a staged directory into place.

    A directory rename is the atomic step, but on Windows it raises
    PermissionError whenever anything else holds a handle inside either tree --
    an indexer, an antivirus scan, or simply another worker serving an image
    from the previous revision. Retry briefly, then fall back to copy + delete,
    which is slower but always finishes.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            if target.exists():
                trash = target.with_name(f"{target.name}.replaced-{uuid.uuid4().hex[:8]}")
                os.replace(target, trash)
                shutil.rmtree(trash, ignore_errors=True)
            os.replace(source, target)
            return
        except (PermissionError, OSError) as exc:
            last = exc
            time.sleep(0.15 * (attempt + 1))

    try:
        shutil.copytree(source, target, dirs_exist_ok=True)
        shutil.rmtree(source, ignore_errors=True)
    except OSError as exc:
        raise SubmissionError(
            f"could not install into {target}: {exc} (earlier: {last})", status=500
        ) from exc


def cleanup(staged: Staged) -> None:
    root = staged.root
    staging_root = (settings.DATA_DIR / ".staging").resolve()
    try:
        if root.exists() and root.resolve().is_relative_to(staging_root):
            shutil.rmtree(root, ignore_errors=True)
    except OSError:
        pass


# ------------------------------------------------------------- catalog


def _review_summary(review_queue: dict[str, Any]) -> dict[str, Any]:
    items = _array(review_queue, "items")
    summary: dict[str, Any] = {"total": len(items), "by_status": {}, "by_priority": {}, "by_type": {}}
    for item in items:
        for out_key, in_key in (("by_status", "status"), ("by_priority", "priority"), ("by_type", "item_type")):
            value = str((item or {}).get(in_key, "unknown"))
            summary[out_key][value] = summary[out_key].get(value, 0) + 1
    return summary


def build_entry(dataset_dir: Path, dataset_id: str, revision: str, asset_prefix: str) -> dict[str, Any]:
    dataset = _read_json(dataset_dir / REQUIRED_FILE)
    paper = dataset.get("paper", {}) if isinstance(dataset.get("paper"), dict) else {}
    run = dataset.get("run", {}) if isinstance(dataset.get("run"), dict) else {}
    queue_path = dataset_dir / "data/review_queue.json"
    review_queue = _read_json(queue_path) if queue_path.is_file() else {"items": []}
    manifest = _read_json(dataset_dir / "manifest.json") if (dataset_dir / "manifest.json").is_file() else {}

    files = {
        name: relative
        for name, relative in {
            "dataset": "data/dataset.json",
            "review_queue": "data/review_queue.json",
            "alignment_candidates": "data/alignment_candidates.json",
            "database_rows": "data/database_rows.json",
            "route_svg": "report/route.svg",
            "extraction_summary": "report/extraction_summary.md",
            "reactions_csv": "data/reactions.csv",
            "reaction_smiles_csv": "data/reaction_smiles.csv",
        }.items()
        if (dataset_dir / relative).is_file()
    }
    base = f"{asset_prefix.rstrip('/')}/{dataset_id}/{revision}"
    target = run.get("target_compound_uid") or (dataset.get("document_map") or {}).get("target_molecule", {}).get("name")

    counts = {
        key: len(_array(dataset, key))
        for key in ("compounds", "reactions", "procedures", "alignments", "evidence", "issues", "validations")
    }
    return {
        "dataset_id": dataset_id,
        "paper_id": str(paper.get("paper_id") or run.get("paper_id") or dataset_id),
        "schema_version": dataset.get("schema_version", "unknown"),
        "revision": revision,
        "title": paper.get("title"),
        "doi": paper.get("doi"),
        "year": paper.get("year"),
        "target": target,
        "pipeline_state": run.get("pipeline_state"),
        "ingested_at": manifest.get("ingested_at"),
        "submitted_by": manifest.get("submitted_by"),
        "files": files,
        "urls": {name: f"{base}/{relative}" for name, relative in files.items()},
        "asset_base": f"{base}/",
        "asset_roots": {name: f"{base}/{name}/" for name in ASSET_DIRS if (dataset_dir / name).is_dir()},
        "counts": counts,
        "entity_total": counts["compounds"] + counts["reactions"] + counts["alignments"],
        "review": _review_summary(review_queue),
        "integrity": manifest.get("integrity", {}),
    }


def validate_catalog(catalog: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for entry in catalog["datasets"]:
        dataset_id = entry.get("dataset_id")
        if not dataset_id:
            errors.append("dataset without dataset_id")
        elif dataset_id in seen:
            errors.append(f"duplicate dataset_id: {dataset_id}")
        seen.add(str(dataset_id))
        for url in list(entry.get("urls", {}).values()) + list(entry.get("asset_roots", {}).values()):
            if "\\" in url or ".." in url.split("/"):
                errors.append(f"unsafe public URL: {url}")
    return errors


def rebuild_catalog(write: bool = True) -> dict[str, Any]:
    datasets_dir = settings.datasets_dir
    entries: list[dict[str, Any]] = []
    if datasets_dir.is_dir():
        for dataset_path in sorted(datasets_dir.iterdir()):
            if not dataset_path.is_dir() or dataset_path.name.startswith("."):
                continue
            revisions = sorted(
                (p for p in dataset_path.iterdir() if p.is_dir() and (p / REQUIRED_FILE).is_file()),
                key=lambda p: p.stat().st_mtime,
            )
            if not revisions:
                continue
            current = revisions[-1]
            entry = build_entry(current, dataset_path.name, current.name, settings.ASSET_URL_PREFIX)
            entry["available_revisions"] = [p.name for p in revisions]
            entries.append(entry)

    catalog = {
        "schema_version": "review.catalog.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asset_url_prefix": settings.ASSET_URL_PREFIX,
        "contracts": CONTRACTS,
        "datasets": entries,
    }
    problems = validate_catalog(catalog)
    if problems:
        raise SubmissionError("catalog validation failed", {"errors": problems}, status=500)

    if write:
        settings.DATA_DIR.mkdir(parents=True, exist_ok=True)
        settings.catalog_path.write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        # The running server caches the catalog and every bundle; drop both so
        # a submission is visible without a restart.
        from . import bundle as bundles

        bundles.invalidate()
    return catalog


def catalog_entry_for(dataset_id: str) -> dict[str, Any] | None:
    from . import bundle as bundles

    return bundles.catalog_entry(dataset_id)
