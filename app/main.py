"""FastAPI app: catalog, dataset bundles, assets, depiction, review events.

    uvicorn app.main:app --port 8770

Route order matters: the static mount is registered last so `/api/v1/*` and
`/review-data/*` win.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import bundle as bundles
from . import depict, evidence as evidence_mod, storage, verify
from .config import settings
from .events import DECISIONS, DuplicateEvent, store

app = FastAPI(title="Synthesis Review", version=settings.VERSION, docs_url="/api/docs")

if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["ETag"],
    )

API = "/api/v1"


# ----------------------------------------------------------------- helpers


def _bundle(dataset_id: str, revision: str | None = None) -> dict[str, Any]:
    resolved = bundles.resolve_revision(dataset_id, revision)
    if resolved is None:
        raise HTTPException(status_code=404, detail=f"unknown dataset or revision: {dataset_id}/{revision}")
    try:
        return bundles.load_bundle(dataset_id, resolved)
    except storage.AssetNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _item_lookup(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        item.get("review_item_uid"): item
        for item in data.get("review_queue", {}).get("items", [])
        if item.get("review_item_uid")
    }


def _validate_item_uid(data: dict[str, Any], review_item_uid: str) -> dict[str, Any]:
    """Queue items must exist. Ad-hoc items must point at a real entity.

    Ad-hoc ids (``ADHOC:compound:CMP_0003``) exist because the queue only holds
    detected problems; a reviewer confirming a structure that nothing flagged is
    still recording a decision, and it belongs in the same event log.
    """
    items = _item_lookup(data)
    if review_item_uid in items:
        item = items[review_item_uid]
        return {"item_type": item.get("item_type"), "entity_uid": item.get("entity_uid")}

    if review_item_uid.startswith("ADHOC:"):
        parts = review_item_uid.split(":")
        if len(parts) != 3 or not parts[2]:
            raise HTTPException(status_code=422, detail="ad-hoc id must be ADHOC:<kind>:<entity_uid>")
        _, kind, entity_uid = parts
        index = bundles.entity_index(data)
        if kind not in index:
            raise HTTPException(status_code=422, detail=f"unknown ad-hoc kind: {kind}")
        if entity_uid not in index[kind]:
            raise HTTPException(status_code=404, detail=f"{kind} not found: {entity_uid}")
        return {"item_type": f"adhoc_{kind}", "entity_uid": entity_uid}

    raise HTTPException(status_code=404, detail=f"unknown review item: {review_item_uid}")


# ------------------------------------------------------------------ system


@app.get(f"{API}/health")
def health() -> dict[str, Any]:
    catalog = bundles.load_catalog()
    return {
        "status": "ok",
        "version": settings.VERSION,
        "rdkit": {"available": depict.AVAILABLE, "error": depict.IMPORT_ERROR},
        "datasets": len(catalog.get("datasets", [])),
        "catalog_path": str(settings.catalog_path),
        "catalog_present": settings.catalog_path.is_file(),
        "database": settings.database_url,
        "events_writable": _events_writable(),
        "default_reviewer": settings.DEFAULT_REVIEWER,
    }


def _events_writable() -> bool:
    try:
        store._connect().execute("SELECT 1 FROM review_events LIMIT 1")  # noqa: SLF001
        return True
    except Exception:  # pragma: no cover - surfaced in the UI as a red banner
        return False


@app.post(f"{API}/admin/reload")
def reload_caches() -> dict[str, Any]:
    bundles.invalidate()
    return {"reloaded": True, "datasets": len(bundles.load_catalog().get("datasets", []))}


@app.get(f"{API}/catalog")
def catalog() -> dict[str, Any]:
    return bundles.load_catalog()


# ----------------------------------------------------------------- dataset


@app.get(f"{API}/datasets/{{dataset_id}}")
def dataset(dataset_id: str, revision: str | None = Query(None)) -> Response:
    data = _bundle(dataset_id, revision)
    payload = dict(data)
    payload["verifications"] = verify.verify_all(data["dataset"])
    payload["review_state"] = store.current(dataset_id)
    body = json.dumps(payload, ensure_ascii=False)
    if len(body) > settings.BUNDLE_WARN_BYTES:
        payload["oversized"] = True
    return Response(
        content=body,
        media_type="application/json",
        headers={"ETag": data["revision"], "Cache-Control": "no-cache"},
    )


@app.get(f"{API}/datasets/{{dataset_id}}/review-items")
def review_items(dataset_id: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    state = store.current(dataset_id)
    items = []
    for item in data["review_queue"].get("items", []):
        merged = dict(item)
        merged["review"] = state.get(item.get("review_item_uid"))
        items.append(merged)
    return {"dataset_id": dataset_id, "revision": data["revision"], "items": items, "stats": store.stats(dataset_id)}


@app.get(f"{API}/datasets/{{dataset_id}}/compounds/{{compound_uid}}")
def compound(dataset_id: str, compound_uid: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    for record in data["dataset"].get("compounds", []):
        if record.get("compound_uid") == compound_uid:
            return record
    raise HTTPException(status_code=404, detail=compound_uid)


@app.get(f"{API}/datasets/{{dataset_id}}/reactions/{{reaction_uid}}")
def reaction(dataset_id: str, reaction_uid: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    for record in data["dataset"].get("reactions", []):
        if record.get("reaction_uid") == reaction_uid:
            return record
    raise HTTPException(status_code=404, detail=reaction_uid)


@app.get(f"{API}/datasets/{{dataset_id}}/evidence/{{evidence_id}}")
def evidence(dataset_id: str, evidence_id: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    record = evidence_mod.find(data, evidence_id)
    if record is None:
        raise HTTPException(status_code=404, detail=evidence_id)
    resolved = evidence_mod.resolve(data, record)
    resolved["detections"] = evidence_mod.detection_boxes(data, record.get("scheme_id"))
    return resolved


@app.get(f"{API}/datasets/{{dataset_id}}/schemes/{{scheme_id}}/detections")
def detections(dataset_id: str, scheme_id: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    return {
        "scheme_id": scheme_id,
        "detections": evidence_mod.detection_boxes(data, scheme_id),
        "moldet": (data.get("moldet") or {}).get(scheme_id),
    }


@app.get(f"{API}/datasets/{{dataset_id}}/alignments/{{alignment_uid}}/verify-source")
def verify_source(dataset_id: str, alignment_uid: str, revision: str | None = Query(None)) -> dict[str, Any]:
    data = _bundle(dataset_id, revision)
    for record in data["dataset"].get("alignments", []):
        if record.get("alignment_uid") == alignment_uid:
            result = verify.verify_alignment(data["dataset"], record)
            result["claimed_by_model"] = bool(record.get("source_verified"))
            return result
    raise HTTPException(status_code=404, detail=alignment_uid)


# ------------------------------------------------------------------ events


@app.get(f"{API}/datasets/{{dataset_id}}/review-events")
def list_events(dataset_id: str, item: str | None = Query(None)) -> dict[str, Any]:
    return {
        "dataset_id": dataset_id,
        "events": store.list(dataset_id, item),
        "current": store.current(dataset_id),
        "stats": store.stats(dataset_id),
    }


@app.get(f"{API}/datasets/{{dataset_id}}/review-events/export.jsonl")
def export_events(dataset_id: str) -> StreamingResponse:
    return StreamingResponse(
        store.export_jsonl(dataset_id),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f'attachment; filename="{dataset_id}_review_events.jsonl"'},
    )


@app.post(f"{API}/datasets/{{dataset_id}}/review-events", status_code=201)
def create_event(
    dataset_id: str,
    payload: dict[str, Any] = Body(...),
    if_match: str | None = Header(None, alias="If-Match"),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    reviewer_header: str | None = Header(None, alias="X-Reviewer-Id"),
) -> JSONResponse:
    data = _bundle(dataset_id)

    if if_match and if_match.strip('"') != data["revision"]:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "revision_mismatch",
                "current_revision": data["revision"],
                "sent_revision": if_match,
                "message": "the dataset was re-extracted; reload before reviewing",
            },
        )

    decision = payload.get("decision")
    if decision not in DECISIONS:
        raise HTTPException(status_code=422, detail=f"decision must be one of {DECISIONS}")

    review_item_uid = payload.get("review_item_uid")
    if not review_item_uid:
        raise HTTPException(status_code=422, detail="review_item_uid is required")
    meta = _validate_item_uid(data, str(review_item_uid))

    reviewer = (payload.get("reviewer_id") or reviewer_header or settings.DEFAULT_REVIEWER or "").strip()
    if settings.REQUIRE_REVIEWER and (not reviewer or reviewer == "anonymous"):
        raise HTTPException(status_code=401, detail="reviewer identity required")

    corrected = payload.get("corrected_value")
    if decision == "corrected" and corrected is None:
        raise HTTPException(status_code=422, detail="corrected decisions need a corrected_value")

    event = {
        # Server-owned fields. Anything the client sent for these is discarded.
        "review_event_uid": f"REV_{uuid.uuid4().hex[:20].upper()}",
        "dataset_id": dataset_id,
        "dataset_revision": data["revision"],
        "schema_version": data["schema_version"],
        "review_item_uid": str(review_item_uid),
        "item_type": meta["item_type"],
        "entity_uid": meta["entity_uid"],
        "decision": decision,
        "corrected_value": corrected,
        "reviewer_id": reviewer or "anonymous",
        "comment": (payload.get("comment") or None),
        "idempotency_key": idempotency_key,
        "client": payload.get("client") or "web",
    }
    try:
        stored = store.append(event)
    except DuplicateEvent as duplicate:
        return JSONResponse(status_code=200, content={"event": duplicate.event, "duplicate": True})
    return JSONResponse(status_code=201, content={"event": stored, "duplicate": False})


# ------------------------------------------------------------- depiction


@app.get(f"{API}/render.svg")
def render(
    smiles: str = Query(...),
    w: int = Query(320, ge=60, le=1600),
    h: int = Query(220, ge=60, le=1600),
    theme: str = Query("light"),
    stereo: int = Query(1),
) -> Response:
    svg = depict.render_svg(smiles, w, h, "dark" if theme == "dark" else "light", bool(stereo))
    return Response(content=svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get(f"{API}/molecule")
def molecule(smiles: str = Query(...)) -> dict[str, Any]:
    return depict.properties(smiles)


# ---------------------------------------------------------------- assets


@app.get("/review-data/datasets/{dataset_id}/{revision}/{path:path}")
def asset(dataset_id: str, revision: str, path: str) -> FileResponse:
    try:
        resolved = storage.resolve(dataset_id, revision, path)
    except storage.UnsafePath as exc:
        raise HTTPException(status_code=400, detail=f"rejected path: {exc}") from exc
    except storage.AssetNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(
        resolved,
        headers={"Cache-Control": f"public, max-age={settings.ASSET_MAX_AGE}"},
    )


# ---------------------------------------------------------------- frontend


@app.middleware("http")
async def revalidate_frontend(request: Request, call_next):
    """The frontend is edited while the server runs; never let a stale module
    pair with a fresh one. ETags still make this a 304 in the common case."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index() -> FileResponse:
    return FileResponse(settings.STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(settings.STATIC_DIR), html=True), name="static")
