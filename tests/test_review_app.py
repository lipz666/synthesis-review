"""Smoke tests against the ingested dataset.

    python -m pytest tests -q

They run against whatever is in REVIEW_DATA_DIR, so they double as a check that
a freshly ingested dataset is actually reviewable.
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app import bundle as bundles
from app import evidence as evidence_mod
from app import verify
from app.main import app

client = TestClient(app)


@pytest.fixture(scope="module")
def entry() -> dict:
    catalog = client.get("/api/v1/catalog").json()
    datasets = catalog.get("datasets") or []
    if not datasets:
        pytest.skip("no dataset ingested; run scripts/ingest_workspace.py first")
    preferred = next((d for d in datasets if d["dataset_id"] == "INELEGANOLIDE_MVP_V2"), datasets[0])
    return preferred


@pytest.fixture(scope="module")
def dataset_id(entry: dict) -> str:
    return entry["dataset_id"]


@pytest.fixture(scope="module")
def revision(entry: dict) -> str:
    return entry["revision"]


@pytest.fixture
def idem() -> str:
    """Fresh idempotency key per test: the event log is persistent, so reusing a
    fixed key would make the second run of the suite see duplicates."""
    return uuid.uuid4().hex


def test_health() -> None:
    payload = client.get("/api/v1/health").json()
    assert payload["status"] == "ok"
    assert payload["catalog_present"] is True


def test_bundle_has_no_local_paths(dataset_id: str) -> None:
    body = client.get(f"/api/v1/datasets/{dataset_id}").text
    # The pipeline writes Windows absolute paths into its JSON; none may survive.
    assert ":\\\\" not in body
    assert "E:\\\\" not in body
    assert "xwechat_files" not in body


def test_private_source_is_dropped(dataset_id: str) -> None:
    payload = client.get(f"/api/v1/datasets/{dataset_id}").json()
    document = payload["dataset"]["paper"]["documents"][0]
    assert document["file_path"] is None
    assert document["_private_source"] is True


def test_asset_urls_resolve(dataset_id: str) -> None:
    payload = client.get(f"/api/v1/datasets/{dataset_id}").json()
    urls = [
        candidate["image_path"]
        for compound in payload["dataset"]["compounds"]
        for candidate in compound["candidates"]
        if candidate.get("image_path")
    ]
    assert urls, "expected OCSR crops"
    response = client.get(urls[0])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/")


def test_asset_traversal_is_refused(dataset_id: str, revision: str) -> None:
    for path in ("../manifest.json", "..%2Fmanifest.json", "data/../../catalog.json"):
        response = client.get(f"/review-data/datasets/{dataset_id}/{revision}/{path}")
        assert response.status_code in (400, 404), path


def test_evidence_fractions_are_within_the_page(dataset_id: str) -> None:
    payload = client.get(f"/api/v1/datasets/{dataset_id}").json()
    boxed = [e for e in payload["dataset"]["evidence"] if e.get("bbox")]
    assert boxed
    for record in boxed[:8]:
        detail = client.get(f"/api/v1/datasets/{dataset_id}/evidence/{record['evidence_id']}").json()
        fractions = detail["fractions"]
        assert fractions, record["evidence_id"]
        assert 0 <= fractions["left"] <= 1
        assert 0 <= fractions["top"] <= 1
        assert 0 < fractions["width"] <= 1
        assert 0 < fractions["height"] <= 1


def test_source_verification_matches_page_text(dataset_id: str) -> None:
    payload = client.get(f"/api/v1/datasets/{dataset_id}").json()
    alignments = payload["dataset"]["alignments"]
    assert alignments
    checked = verify.verify_all(payload["dataset"])
    assert all(entry["verified"] for entry in checked.values()), checked


def test_review_event_roundtrip(dataset_id: str, revision: str, idem: str) -> None:
    items = client.get(f"/api/v1/datasets/{dataset_id}/review-items").json()["items"]
    item_uid = items[0]["review_item_uid"]

    created = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": item_uid, "decision": "deferred", "comment": "pytest"},
        headers={"If-Match": revision, "Idempotency-Key": idem, "X-Reviewer-Id": "pytest"},
    )
    assert created.status_code == 201, created.text
    event = created.json()["event"]
    assert event["dataset_revision"] == revision
    assert event["reviewer_id"] == "pytest"

    # Same key twice -> the first event comes back, nothing new is written.
    repeat = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": item_uid, "decision": "deferred"},
        headers={"If-Match": revision, "Idempotency-Key": idem},
    )
    assert repeat.status_code == 200
    assert repeat.json()["duplicate"] is True
    assert repeat.json()["event"]["review_event_uid"] == event["review_event_uid"]

    listed = client.get(f"/api/v1/datasets/{dataset_id}/review-events?item={item_uid}").json()
    assert any(e["review_event_uid"] == event["review_event_uid"] for e in listed["events"])


def test_stale_revision_is_rejected(dataset_id: str, idem: str) -> None:
    items = client.get(f"/api/v1/datasets/{dataset_id}/review-items").json()["items"]
    response = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": items[0]["review_item_uid"], "decision": "accepted"},
        headers={"If-Match": "0000000000000000", "Idempotency-Key": idem},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "revision_mismatch"


def test_adhoc_items(dataset_id: str, idem: str) -> None:
    payload = client.get(f"/api/v1/datasets/{dataset_id}").json()
    compound_uid = payload["dataset"]["compounds"][0]["compound_uid"]
    revision = payload["revision"]

    ok = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": f"ADHOC:compound:{compound_uid}", "decision": "accepted"},
        headers={"If-Match": revision, "Idempotency-Key": idem},
    )
    assert ok.status_code == 201

    missing = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": "ADHOC:compound:CMP_NOPE", "decision": "accepted"},
        headers={"If-Match": revision, "Idempotency-Key": uuid.uuid4().hex},
    )
    assert missing.status_code == 404


def test_corrected_requires_a_value(dataset_id: str) -> None:
    items = client.get(f"/api/v1/datasets/{dataset_id}/review-items").json()["items"]
    response = client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": items[0]["review_item_uid"], "decision": "corrected"},
        headers={"Idempotency-Key": uuid.uuid4().hex},
    )
    assert response.status_code == 422


def test_extraction_output_is_never_written(dataset_id: str, revision: str) -> None:
    path = bundles.settings.datasets_dir / dataset_id / revision / "data" / "dataset.json"
    before = path.stat().st_mtime_ns
    client.post(
        f"/api/v1/datasets/{dataset_id}/review-events",
        json={"review_item_uid": f"ADHOC:dataset:{dataset_id}", "decision": "deferred"},
        headers={"Idempotency-Key": uuid.uuid4().hex},
    )
    assert path.stat().st_mtime_ns == before
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"]


def test_render_endpoint() -> None:
    response = client.get("/api/v1/render.svg", params={"smiles": "CCO", "w": 200, "h": 150})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg")
    assert "<svg" in response.text


def test_unparsable_smiles_returns_a_placeholder_not_an_error() -> None:
    response = client.get("/api/v1/render.svg", params={"smiles": "not-a-smiles((("})
    assert response.status_code == 200
    assert "<svg" in response.text
