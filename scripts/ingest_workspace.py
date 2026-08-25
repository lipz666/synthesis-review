"""Import an extraction workspace from disk, or rebuild the catalog.

Thin CLI over ``app.ingest`` -- the same validation, staging and atomic install
the HTTP endpoint uses, so a package accepted here is accepted there and vice
versa. For remote submissions use the API instead (see docs/SUBMISSION_FORMAT_ZH.md).

    python scripts/ingest_workspace.py E:\\OSTE\\paper-record-to-eln\\workspaces\\INELEGANOLIDE_MVP_V2
    python scripts/ingest_workspace.py <workspace> --dry-run
    python scripts/ingest_workspace.py <workspace> --force
    python scripts/ingest_workspace.py --rebuild-catalog
    python scripts/ingest_workspace.py <workspace> --pack out.zip   # build a package, submit it elsewhere
"""

from __future__ import annotations

import argparse
import os
import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import ingest as ingest_mod  # noqa: E402
from app.config import settings  # noqa: E402


def pack(workspace: Path, output: Path) -> int:
    """Zip the reviewable subset of a workspace into a submission package."""
    output.parent.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        def add(source: Path, name: str) -> None:
            # `report/` is both a named file group and an asset dir; without this
            # its two files land in the archive twice.
            if name in written or not source.is_file():
                return
            archive.write(source, name)
            written.add(name)

        for relative in ingest_mod.PACKAGE_FILES:
            add(workspace / relative, relative)
        for directory in ingest_mod.ASSET_DIRS:
            root = workspace / directory
            if not root.is_dir():
                continue
            for source in sorted(root.rglob("*")):
                if source.is_file() and source.suffix.lower() in settings.ASSET_SUFFIXES:
                    add(source, source.relative_to(workspace).as_posix())
    print(f"packed {len(written)} files into {output} ({output.stat().st_size / 1e6:.1f} MB)")
    return 0


def report_lines(report: dict) -> None:
    counts = report.get("counts", {})
    print(f"  dataset_id : {report.get('dataset_id')}")
    print(f"  revision   : {report.get('revision')}")
    print(f"  schema     : {report.get('schema_version')}")
    print(
        "  counts     : "
        + " ".join(f"{key}={value}" for key, value in counts.items())
    )
    verification = report.get("source_verification") or {}
    if verification.get("checked"):
        print(f"  src-check  : {verification['verified']}/{verification['checked']} quotes verified")
    for warning in report.get("warnings", []):
        print(f"  WARN  {warning}")
    for error in report.get("errors", []):
        print(f"  ERROR {error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workspace", nargs="?", type=Path, help="extraction workspace directory")
    parser.add_argument("--dataset-id", help="override the dataset id (default: workspace folder name)")
    parser.add_argument("--data-dir", type=Path, help="override REVIEW_DATA_DIR")
    parser.add_argument("--force", action="store_true", help="reinstall even if the revision exists")
    parser.add_argument("--dry-run", action="store_true", help="validate only, write nothing")
    parser.add_argument("--rebuild-catalog", action="store_true", help="only re-index what is already stored")
    parser.add_argument("--pack", type=Path, metavar="OUT.zip", help="build a submission package, do not install")
    args = parser.parse_args()

    if args.data_dir:
        settings.DATA_DIR = args.data_dir.resolve()

    if args.pack:
        if args.workspace is None:
            parser.error("--pack needs a workspace")
        return pack(args.workspace.resolve(), args.pack.resolve())

    if args.rebuild_catalog:
        catalog = ingest_mod.rebuild_catalog()
        for entry in catalog["datasets"]:
            print(f"  {entry['dataset_id']} rev={entry['revision']} review_items={entry['review']['total']}")
        print(f"wrote {settings.catalog_path}")
        return 0

    if args.workspace is None:
        parser.error("workspace is required unless --rebuild-catalog or --pack is given")

    try:
        staged = ingest_mod.stage_directory(args.workspace.resolve())
        report = ingest_mod.install(
            staged,
            args.dataset_id,
            force=args.force,
            dry_run=args.dry_run,
            submitted_by=os.environ.get("USERNAME") or os.environ.get("USER"),
        )
    except ingest_mod.SubmissionError as exc:
        print(f"REJECTED: {exc.message}", file=sys.stderr)
        report_lines(exc.report)
        return 1

    report_lines(report)
    if report.get("installed"):
        print(f"installed -> {settings.datasets_dir / report['dataset_id'] / report['revision']}")
    elif report.get("dry_run"):
        print("dry run: nothing written")
    else:
        print(report.get("message", "nothing to do"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
