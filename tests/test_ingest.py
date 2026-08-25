"""Submission intake: format, validation, safety, idempotency.

The hostile cases matter most here -- ingest is the one endpoint that writes to
the data directory, so traversal, zip bombs and junk payloads must be refused
before anything is staged.
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import ingest as ingest_mod
from app.config import settings
from app.main import app

client = TestClient(app)

MINIMAL_DATASET = {
    "schema_version": "tse.dataset.v1",
    "run": {"paper_id": "UNIT_PAPER", "pipeline_state": "HUMAN_REVIEW", "target_compound_uid": "CMP_2"},
    "paper": {"paper_id": "UNIT_PAPER", "title": "A unit-test synthesis", "doi": "10.0000/unit", "year": 2026,
              "documents": []},
    "document_map": {"target_molecule": {"name": "product"}},
    "compounds": [
        {"compound_uid": "CMP_1", "labels": ["1"], "raw_smiles": "CCO", "structure_status": "validated",
         "confidence": 0.9, "identity": {"canonical_smiles": "CCO", "formula": "C2H6O"},
         "candidates": [], "mentions": [], "evidence_ids": []},
        {"compound_uid": "CMP_2", "labels": ["2"], "raw_smiles": "CC=O", "structure_status": "validated",
         "confidence": 0.9, "identity": {"canonical_smiles": "CC=O", "formula": "C2H4O"},
         "candidates": [], "mentions": [], "evidence_ids": []},
    ],
    "reactions": [
        {"reaction_uid": "RXN_1", "reactants": ["CMP_1"], "products": ["CMP_2"],
         "conditions_raw": "PCC, DCM", "yield": None, "validation_status": "passed",
         "step_index": 0, "evidence_ids": []},
    ],
    "procedures": [],
    "alignments": [],
    "evidence": [],
    "route_graph": {"nodes": [], "edges": [], "target_node_id": "CMP_2"},
    "issues": [],
    "validations": [],
}


def make_zip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def dataset_bytes(overrides: dict | None = None) -> bytes:
    payload = json.loads(json.dumps(MINIMAL_DATASET))
    if overrides:
        payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


@pytest.fixture
def cleanup_datasets():
    created: list[str] = []
    yield created
    for dataset_id in created:
        shutil.rmtree(settings.datasets_dir / dataset_id, ignore_errors=True)
    ingest_mod.rebuild_catalog()


# --------------------------------------------------------------------- spec


def test_spec_is_self_describing() -> None:
    spec = client.get("/api/v1/ingest/spec").json()
    assert spec["format"] == "review.submission.v1"
    assert spec["package_layout"]["required"] == ["data/dataset.json"]
    assert {transport["name"] for transport in spec["transports"]} == {"zip", "json"}
    assert spec["limits"]["max_upload_bytes"] > 0


# ---------------------------------------------------------------- happy path


def test_zip_submission_installs_and_is_idempotent(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_ZIP")
    package = make_zip({"data/dataset.json": dataset_bytes()})

    first = client.post("/api/v1/ingest?dataset_id=UNIT_ZIP", content=package,
                        headers={"Content-Type": "application/zip", "X-Submitted-By": "pytest"})
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["installed"] is True
    assert body["counts"]["compounds"] == 2
    revision = body["revision"]

    # Same bytes -> same revision -> no second copy.
    again = client.post("/api/v1/ingest?dataset_id=UNIT_ZIP", content=package,
                        headers={"Content-Type": "application/zip"})
    assert again.status_code == 200
    assert again.json()["installed"] is False

    # And it is immediately reviewable, without restarting the server.
    catalog = client.get("/api/v1/catalog").json()
    entry = next(e for e in catalog["datasets"] if e["dataset_id"] == "UNIT_ZIP")
    assert entry["revision"] == revision
    assert entry["title"] == "A unit-test synthesis"
    bundle = client.get("/api/v1/datasets/UNIT_ZIP").json()
    assert len(bundle["dataset"]["compounds"]) == 2


def test_json_submission_without_assets(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_JSON")
    response = client.post("/api/v1/ingest/json", json={
        "dataset_id": "UNIT_JSON",
        "dataset": MINIMAL_DATASET,
        "review_queue": {"schema_version": "tse.review_queue.v1", "items": [
            {"review_item_uid": "REVIEW_1", "item_type": "issue", "entity_uid": "CMP_1",
             "priority": "high", "status": "pending", "reason": "check this"},
        ]},
    })
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["counts"]["review_items"] == 1
    items = client.get("/api/v1/datasets/UNIT_JSON/review-items").json()["items"]
    assert items[0]["review_item_uid"] == "REVIEW_1"


def test_single_top_level_folder_is_stripped(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_NESTED")
    package = make_zip({"MY_PAPER/data/dataset.json": dataset_bytes()})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_NESTED", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 201, response.text


def test_dataset_id_falls_back_to_the_archive_folder(cleanup_datasets) -> None:
    cleanup_datasets.append("FOLDER_NAMED_PAPER")
    package = make_zip({"FOLDER_NAMED_PAPER/data/dataset.json": dataset_bytes()})
    response = client.post("/api/v1/ingest", content=package, headers={"Content-Type": "application/zip"})
    assert response.status_code == 201, response.text
    assert response.json()["dataset_id"] == "FOLDER_NAMED_PAPER"


def test_dry_run_writes_nothing() -> None:
    package = make_zip({"data/dataset.json": dataset_bytes()})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_DRY&dry_run=true", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 200
    assert response.json()["installed"] is False
    assert not (settings.datasets_dir / "UNIT_DRY").exists()


# ------------------------------------------------------------------ refusals


def test_zip_slip_is_refused() -> None:
    package = make_zip({"../../evil.json": b"{}", "data/dataset.json": dataset_bytes()})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_EVIL", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 400
    assert not (settings.datasets_dir / "UNIT_EVIL").exists()


def test_absolute_entry_is_refused() -> None:
    package = make_zip({"C:/windows/system32/evil.json": b"{}", "data/dataset.json": dataset_bytes()})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_ABS", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 400


def test_package_without_dataset_json_is_refused() -> None:
    package = make_zip({"pages/p1.png": b"not really a png"})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_EMPTY", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 422
    assert "data/dataset.json" in response.json()["detail"]["message"]


def test_not_a_zip_is_refused() -> None:
    response = client.post("/api/v1/ingest?dataset_id=UNIT_JUNK", content=b"hello",
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 422


def test_dangling_reference_is_an_error() -> None:
    broken = json.loads(json.dumps(MINIMAL_DATASET))
    broken["reactions"][0]["reactants"] = ["CMP_MISSING"]
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "UNIT_BROKEN", "dataset": broken})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert any("CMP_MISSING" in error for error in detail["errors"])
    assert not (settings.datasets_dir / "UNIT_BROKEN").exists()


def test_duplicate_uids_are_errors() -> None:
    broken = json.loads(json.dumps(MINIMAL_DATASET))
    broken["compounds"].append(dict(broken["compounds"][0]))
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "UNIT_DUP", "dataset": broken})
    assert response.status_code == 422
    assert any("duplicate compound_uid" in error for error in response.json()["detail"]["errors"])


def test_reserved_adhoc_prefix_is_refused() -> None:
    response = client.post("/api/v1/ingest/json", json={
        "dataset_id": "UNIT_RESERVED",
        "dataset": MINIMAL_DATASET,
        "review_queue": {"items": [{"review_item_uid": "ADHOC:compound:CMP_1", "item_type": "issue"}]},
    })
    assert response.status_code == 422
    assert any("ADHOC:" in error for error in response.json()["detail"]["errors"])


def test_bad_dataset_id_is_refused() -> None:
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "../escape", "dataset": MINIMAL_DATASET})
    assert response.status_code == 422


def test_unknown_schema_is_stored_with_a_warning(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_FUTURE")
    payload = json.loads(json.dumps(MINIMAL_DATASET))
    payload["schema_version"] = "tse.dataset.v99"
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "UNIT_FUTURE", "dataset": payload})
    assert response.status_code == 201
    assert any("no frontend adapter" in warning for warning in response.json()["warnings"])


def test_missing_assets_are_warned_not_fatal(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_NOIMG")
    payload = json.loads(json.dumps(MINIMAL_DATASET))
    payload["compounds"][0]["candidates"] = [
        {"visual_id": "M001", "smiles": "CCO", "model": "test",
         "image_path": "molecule_crops/SCHEME_1/M001_normal.png", "rdkit_parsable": True},
    ]
    package = make_zip({"data/dataset.json": json.dumps(payload).encode("utf-8")})
    response = client.post("/api/v1/ingest?dataset_id=UNIT_NOIMG", content=package,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 201
    body = response.json()
    assert body["missing_assets"] == ["molecule_crops/SCHEME_1/M001_normal.png"]
    assert any("referenced image" in warning for warning in body["warnings"])


def test_unverifiable_quotes_are_warned(cleanup_datasets) -> None:
    cleanup_datasets.append("UNIT_QUOTE")
    payload = json.loads(json.dumps(MINIMAL_DATASET))
    payload["alignments"] = [{
        "alignment_uid": "ALIGN_1", "reaction_uid": "RXN_1", "document_id": "DOC_MAIN", "page": 1,
        "char_start": 0, "char_end": 20, "text": "a quote nobody can check",
        "relation": "direct_reaction_description", "source_verified": True,
    }]
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "UNIT_QUOTE", "dataset": payload})
    assert response.status_code == 201
    body = response.json()
    # The model claimed source_verified; the server could not confirm it.
    assert body["source_verification"]["verified"] == 0
    assert any("could not be re-checked" in warning for warning in body["warnings"])


# --------------------------------------------------------------------- auth


def test_token_is_enforced_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "INGEST_TOKEN", "s3cret")
    package = make_zip({"data/dataset.json": dataset_bytes()})
    denied = client.post("/api/v1/ingest?dataset_id=UNIT_AUTH", content=package,
                         headers={"Content-Type": "application/zip"})
    assert denied.status_code == 401
    wrong = client.post("/api/v1/ingest?dataset_id=UNIT_AUTH", content=package,
                        headers={"Content-Type": "application/zip", "X-Api-Key": "nope"})
    assert wrong.status_code == 401
    assert not (settings.datasets_dir / "UNIT_AUTH").exists()


def test_ingest_can_be_disabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "INGEST_ENABLED", False)
    response = client.post("/api/v1/ingest/json", json={"dataset_id": "UNIT_OFF", "dataset": MINIMAL_DATASET})
    assert response.status_code == 503


def test_oversized_upload_is_refused(monkeypatch) -> None:
    monkeypatch.setattr(settings, "INGEST_MAX_BYTES", 100)
    response = client.post("/api/v1/ingest?dataset_id=UNIT_BIG", content=b"x" * 500,
                           headers={"Content-Type": "application/zip"})
    assert response.status_code == 413


# ------------------------------------------------------------- staging area


def test_staging_area_is_left_clean() -> None:
    package = make_zip({"data/dataset.json": dataset_bytes()})
    client.post("/api/v1/ingest?dataset_id=UNIT_CLEAN&dry_run=true", content=package,
                headers={"Content-Type": "application/zip"})
    client.post("/api/v1/ingest?dataset_id=UNIT_EVIL2", content=make_zip({"../x.json": b"{}"}),
                headers={"Content-Type": "application/zip"})
    staging = settings.DATA_DIR / ".staging"
    leftovers = list(staging.iterdir()) if staging.is_dir() else []
    assert leftovers == [], leftovers
