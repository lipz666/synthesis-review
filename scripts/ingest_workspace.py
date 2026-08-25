"""Copy an extraction workspace into this project's data store and rebuild the catalog.

This is the only bridge to the extraction pipeline. It runs once per extraction,
copies the reviewable files into ``data/datasets/{dataset_id}/{revision}/`` and
regenerates ``data/catalog.json``. After it finishes the review app needs nothing
from the pipeline repository -- the data directory is self-contained and can be
rsynced or uploaded to object storage as-is.

    python scripts/ingest_workspace.py E:\\OSTE\\paper-record-to-eln\\workspaces\\INELEGANOLIDE_MVP_V2
    python scripts/ingest_workspace.py <workspace> --data-dir /srv/review-data
    python scripts/ingest_workspace.py --rebuild-catalog        # no copy, just re-index

The revision is computed exactly like the pipeline's own
``scripts/build_review_catalog.py`` (sha256 of dataset.json + review_queue.json),
so a dataset ingested here carries the same revision string as upstream.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Files copied verbatim. Anything not listed stays in the pipeline repository:
# `state/`, `source/` and the original PDF are deliberately not published.
DATA_FILES = [
    "data/dataset.json",
    "data/database_rows.json",
    "data/review_queue.json",
    "data/compounds.json",
    "data/reactions.json",
    "data/alignments.json",
    "data/alignment_candidates.json",
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
]
ASSET_DIRS = ["pages", "schemes", "molecule_crops", "moldet", "evidence", "report"]

CONTRACTS = {
    "tse.dataset.v1": {"documentation": "DATA_CONTRACT_V1_ZH.md"},
    "synthlit.interchange.v1": {"documentation": "INTERCHANGE_CONTRACT_V1_ZH.md"},
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compute_revision(workspace: Path) -> tuple[str, str, str | None]:
    dataset_hash = sha256(workspace / "data" / "dataset.json")
    queue_path = workspace / "data" / "review_queue.json"
    queue_hash = sha256(queue_path) if queue_path.is_file() else None
    seed = f"{dataset_hash}:{queue_hash or ''}".encode()
    return hashlib.sha256(seed).hexdigest()[:16], dataset_hash, queue_hash


def copy_workspace(workspace: Path, target: Path) -> dict[str, int]:
    stats = {"files": 0, "bytes": 0}

    def copy(src: Path, dst: Path) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        stats["files"] += 1
        stats["bytes"] += src.stat().st_size

    for relative in DATA_FILES:
        src = workspace / relative
        if src.is_file():
            copy(src, target / relative)

    for directory in ASSET_DIRS:
        src_dir = workspace / directory
        if not src_dir.is_dir():
            continue
        for src in sorted(src_dir.rglob("*")):
            if src.is_file():
                copy(src, target / src.relative_to(workspace))
    return stats


def array_count(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key, [])
    return len(value) if isinstance(value, list) else 0


def review_summary(review_queue: dict[str, Any]) -> dict[str, Any]:
    items = review_queue.get("items", [])
    summary: dict[str, Any] = {"total": len(items), "by_status": {}, "by_priority": {}, "by_type": {}}
    for item in items:
        for out_key, in_key in (("by_status", "status"), ("by_priority", "priority"), ("by_type", "item_type")):
            value = str(item.get(in_key, "unknown"))
            summary[out_key][value] = summary[out_key].get(value, 0) + 1
    return summary


def entity_total(dataset: dict[str, Any]) -> int:
    """How many things a human could plausibly be asked to look at.

    The review queue only holds detected problems (5 for the MVP dataset); the
    real workload is every structure, every reaction and every alignment. The UI
    shows both numbers, so the catalog carries both.
    """
    return (
        array_count(dataset, "compounds")
        + array_count(dataset, "reactions")
        + array_count(dataset, "alignments")
    )


def build_entry(dataset_dir: Path, dataset_id: str, revision: str, asset_prefix: str) -> dict[str, Any]:
    dataset = read_json(dataset_dir / "data" / "dataset.json")
    paper = dataset.get("paper", {})
    run = dataset.get("run", {})
    queue_path = dataset_dir / "data" / "review_queue.json"
    review_queue = read_json(queue_path) if queue_path.is_file() else {"items": []}

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

    target = run.get("target_compound_uid") or dataset.get("document_map", {}).get(
        "target_molecule", {}
    ).get("name")

    manifest = read_json(dataset_dir / "manifest.json") if (dataset_dir / "manifest.json").is_file() else {}

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
        "files": files,
        "urls": {name: f"{base}/{relative}" for name, relative in files.items()},
        "asset_base": f"{base}/",
        "asset_roots": {
            name: f"{base}/{name}/" for name in ASSET_DIRS if (dataset_dir / name).is_dir()
        },
        "counts": {
            key: array_count(dataset, key)
            for key in ("compounds", "reactions", "procedures", "alignments", "evidence", "issues", "validations")
        },
        "entity_total": entity_total(dataset),
        "review": review_summary(review_queue),
        "integrity": manifest.get("integrity", {}),
    }


def rebuild_catalog(data_dir: Path, asset_prefix: str) -> dict[str, Any]:
    datasets_dir = data_dir / "datasets"
    entries: list[dict[str, Any]] = []
    if datasets_dir.is_dir():
        for dataset_path in sorted(datasets_dir.iterdir()):
            if not dataset_path.is_dir():
                continue
            revisions = sorted(
                (p for p in dataset_path.iterdir() if p.is_dir() and (p / "data" / "dataset.json").is_file()),
                key=lambda p: p.stat().st_mtime,
            )
            if not revisions:
                print(f"  skip {dataset_path.name}: no revision with data/dataset.json")
                continue
            current = revisions[-1]
            entry = build_entry(current, dataset_path.name, current.name, asset_prefix)
            entry["available_revisions"] = [p.name for p in revisions]
            entries.append(entry)

    catalog = {
        "schema_version": "review.catalog.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "asset_url_prefix": asset_prefix,
        "contracts": CONTRACTS,
        "datasets": entries,
    }
    errors = validate(catalog)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
    return catalog


def validate(catalog: dict[str, Any]) -> list[str]:
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
            if "\\" in url or ":" in url.split("//")[-1].split("/")[0]:
                errors.append(f"local path leaked into public URL: {url}")
            if ".." in url.split("/"):
                errors.append(f"parent path segment in public URL: {url}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workspace", nargs="?", type=Path, help="extraction workspace directory")
    parser.add_argument("--dataset-id", help="override the dataset id (default: workspace folder name)")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("REVIEW_DATA_DIR", PROJECT_ROOT / "data")))
    parser.add_argument("--asset-prefix", default=os.environ.get("REVIEW_ASSET_URL_PREFIX", "/review-data/datasets"))
    parser.add_argument("--rebuild-catalog", action="store_true", help="only re-index what is already in the data dir")
    parser.add_argument("--force", action="store_true", help="re-copy even if the revision already exists")
    args = parser.parse_args()

    data_dir = args.data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    if not args.rebuild_catalog:
        if args.workspace is None:
            parser.error("workspace is required unless --rebuild-catalog is given")
        workspace = args.workspace.resolve()
        dataset_json = workspace / "data" / "dataset.json"
        if not dataset_json.is_file():
            print(f"ERROR: {dataset_json} not found -- is this an extraction workspace?", file=sys.stderr)
            return 1

        dataset_id = args.dataset_id or workspace.name
        revision, dataset_hash, queue_hash = compute_revision(workspace)
        target = data_dir / "datasets" / dataset_id / revision

        if target.exists() and not args.force:
            print(f"{dataset_id} revision {revision} already ingested -- skipping copy (use --force to redo)")
        else:
            if target.exists():
                shutil.rmtree(target)
            print(f"copying {workspace} -> {target}")
            stats = copy_workspace(workspace, target)
            (target / "manifest.json").write_text(
                json.dumps(
                    {
                        "dataset_id": dataset_id,
                        "revision": revision,
                        "ingested_at": datetime.now(timezone.utc).isoformat(),
                        # Kept for provenance only. It is never served to a browser.
                        "source_workspace": str(workspace),
                        "integrity": {"dataset_sha256": dataset_hash, "review_queue_sha256": queue_hash},
                        "files": stats["files"],
                        "bytes": stats["bytes"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            print(f"  {stats['files']} files, {stats['bytes'] / 1e6:.1f} MB")

    print("rebuilding catalog")
    catalog = rebuild_catalog(data_dir, args.asset_prefix)
    (data_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for entry in catalog["datasets"]:
        print(
            f"  {entry['dataset_id']} rev={entry['revision']} schema={entry['schema_version']} "
            f"compounds={entry['counts']['compounds']} reactions={entry['counts']['reactions']} "
            f"review_items={entry['review']['total']}"
        )
    print(f"wrote {data_dir / 'catalog.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
