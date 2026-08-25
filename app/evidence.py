"""Turn a raw evidence record into something a browser can draw a box on.

All the coordinate arithmetic lives here, on purpose. The data mixes coordinate
spaces -- ``page_px`` at 450 dpi for evidence, ``image_px`` relative to the
scheme crop for YOLO detections, plus a normalised ``raw``/``yxyx@1000`` copy
that must be ignored -- and getting it wrong puts boxes on the wrong molecule
without ever raising an error.

The output is fractions of the base image (0..1), never CSS pixels, so the
overlay stays correct when the image is scaled, zoomed or reflowed.
"""

from __future__ import annotations

from typing import Any

from . import storage


def _page_entry(bundle: dict[str, Any], document_id: str | None, page: int | None) -> dict[str, Any] | None:
    for entry in bundle.get("pages", []):
        if entry.get("page") == page and (document_id is None or entry.get("document_id") == document_id):
            return entry
    return None


def _pick_render(page: dict[str, Any], preferred_dpi: int | None) -> dict[str, Any] | None:
    renders = page.get("renders") or {}
    if not renders:
        return None
    keys = sorted(int(k) for k in renders)
    chosen = preferred_dpi if preferred_dpi in keys else keys[-1]
    render = dict(renders[chosen])
    render["dpi"] = chosen
    return render


def _fractions(box: dict[str, Any], width_px: float, height_px: float) -> dict[str, float] | None:
    if not width_px or not height_px:
        return None
    x0, y0 = float(box["x0"]), float(box["y0"])
    x1, y1 = float(box["x1"]), float(box["y1"])
    left, right = sorted((x0, x1))
    top, bottom = sorted((y0, y1))
    return {
        "left": max(0.0, left / width_px),
        "top": max(0.0, top / height_px),
        "width": min(1.0, (right - left) / width_px),
        "height": min(1.0, (bottom - top) / height_px),
    }


def _scheme_image(bundle: dict[str, Any], scheme_id: str | None) -> dict[str, Any] | None:
    """Scheme crop plus its pixel size, taken from the detector's own record."""
    if not scheme_id:
        return None
    detections = (bundle.get("moldet") or {}).get(scheme_id)
    dataset_id, revision = bundle["dataset_id"], bundle["revision"]
    relative = f"schemes/{scheme_id}.png"
    url = storage.asset_url(dataset_id, revision, relative) if storage.exists(dataset_id, revision, relative) else None
    overlay_rel = f"moldet/{scheme_id}/{scheme_id}_moldet.png"
    overlay = (
        storage.asset_url(dataset_id, revision, overlay_rel)
        if storage.exists(dataset_id, revision, overlay_rel)
        else None
    )
    if detections is None:
        return {"scheme_id": scheme_id, "url": url, "overlay_url": overlay, "width_px": None, "height_px": None}
    return {
        "scheme_id": scheme_id,
        "url": detections.get("image_path") or url,
        "overlay_url": overlay,
        "width_px": detections.get("image_width"),
        "height_px": detections.get("image_height"),
        "detector": detections.get("detector"),
    }


def detection_boxes(bundle: dict[str, Any], scheme_id: str | None) -> list[dict[str, Any]]:
    """Every YOLO box on a scheme, as fractions of the scheme image."""
    scheme = _scheme_image(bundle, scheme_id)
    if not scheme or not scheme.get("width_px"):
        return []
    detections = (bundle.get("moldet") or {}).get(scheme_id, {})
    out: list[dict[str, Any]] = []
    for detection in detections.get("detections", []) or []:
        box = detection.get("bbox") or {}
        if not all(key in box for key in ("x0", "y0", "x1", "y1")):
            continue
        fractions = _fractions(box, scheme["width_px"], scheme["height_px"])
        if fractions:
            out.append(
                {
                    "detection_id": detection.get("detection_id"),
                    "confidence": detection.get("confidence"),
                    "fractions": fractions,
                }
            )
    return out


def resolve(bundle: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    """Attach a base image and box fractions to one evidence record."""
    box = evidence.get("bbox")
    space = (box or {}).get("coord_space")
    page = _page_entry(bundle, evidence.get("document_id"), evidence.get("page"))
    result: dict[str, Any] = {
        "evidence": evidence,
        "page": page,
        "base": None,
        "fractions": None,
        "coord_space": space,
        "note": None,
        "scheme": _scheme_image(bundle, evidence.get("scheme_id")),
        "crop_url": evidence.get("image_path") if evidence.get("evidence_type") == "molecule_image" else None,
    }

    if evidence.get("evidence_type") == "page_text" or box is None:
        if page:
            render = _pick_render(page, 150)
            if render:
                result["base"] = {"kind": "page", **render}
        result["note"] = "text evidence: character range only, no layout box"
        return result

    if space == "page_px":
        if page is None:
            result["note"] = "page render not found for this evidence"
            return result
        # Fractions are dpi-independent, so the base image does not have to be
        # the dpi the box was measured at: default to the light 150 dpi render
        # and let the UI offer the heavy one on demand.
        render = _pick_render(page, 150)
        if render is None:
            result["note"] = "no page render available"
            return result
        result["renders"] = [
            {"dpi": int(dpi), **values} for dpi, values in sorted((page.get("renders") or {}).items())
        ]
        # The box was measured at bbox.dpi; the render may be a different dpi.
        # Working in fractions makes the dpi difference cancel out, as long as
        # the divisor is the page size at the *box's* dpi.
        box_dpi = int(box.get("dpi") or render["dpi"])
        width_px = float(page.get("width_pt") or 0) * box_dpi / 72
        height_px = float(page.get("height_pt") or 0) * box_dpi / 72
        result["base"] = {"kind": "page", **render}
        result["fractions"] = _fractions(box, width_px, height_px)
        return result

    if space == "image_px":
        scheme = result["scheme"]
        if scheme and scheme.get("width_px"):
            result["base"] = {
                "kind": "scheme",
                "url": scheme["url"],
                "width_px": scheme["width_px"],
                "height_px": scheme["height_px"],
            }
            result["fractions"] = _fractions(box, scheme["width_px"], scheme["height_px"])
        else:
            result["note"] = "scheme image size unknown"
        return result

    result["note"] = f"unsupported coord_space: {space!r}"
    return result


def find(bundle: dict[str, Any], evidence_id: str) -> dict[str, Any] | None:
    for record in bundle["dataset"].get("evidence", []) or []:
        if record.get("evidence_id") == evidence_id:
            return record
    return None
