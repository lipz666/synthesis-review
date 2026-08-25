"""Re-check quoted paper text against the extracted page text.

An alignment carries ``source_verified`` from the extraction model. That flag is
the model's own claim about itself, so the UI never trusts it. Instead the server
re-slices the page text with the stored character offsets and compares. Only a
byte-for-byte match (after whitespace normalisation -- the stored copy collapses
line breaks) earns the green "verified against the paper" badge.
"""

from __future__ import annotations

import re
from typing import Any

WHITESPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    return WHITESPACE.sub(" ", text or "").strip()


def _page_text(dataset: dict[str, Any], document_id: str | None, page: int | None) -> str | None:
    for document in dataset.get("paper", {}).get("documents", []) or []:
        if document_id and document.get("document_id") != document_id:
            continue
        for entry in document.get("pages", []) or []:
            if entry.get("page") == page:
                return entry.get("text")
    return None


def verify_span(
    dataset: dict[str, Any],
    document_id: str | None,
    page: int | None,
    char_start: int | None,
    char_end: int | None,
    stored_text: str | None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "verified": False,
        "reason": None,
        "document_id": document_id,
        "page": page,
        "char_start": char_start,
        "char_end": char_end,
        "page_slice": None,
        "stored_text": stored_text,
    }
    if stored_text is None:
        result["reason"] = "no_stored_text"
        return result
    if char_start is None or char_end is None:
        result["reason"] = "no_offsets"
        return result

    text = _page_text(dataset, document_id, page)
    if text is None:
        result["reason"] = "page_not_found"
        return result
    if not text.strip():
        result["reason"] = "no_text_layer"
        return result
    if char_start < 0 or char_end > len(text) or char_start >= char_end:
        result["reason"] = "offsets_out_of_range"
        result["page_length"] = len(text)
        return result

    page_slice = text[char_start:char_end]
    result["page_slice"] = page_slice
    if normalise(page_slice) == normalise(stored_text):
        result["verified"] = True
        result["reason"] = "exact"
    else:
        result["reason"] = "text_mismatch"
    return result


def verify_alignment(dataset: dict[str, Any], alignment: dict[str, Any]) -> dict[str, Any]:
    return verify_span(
        dataset,
        alignment.get("document_id"),
        alignment.get("page"),
        alignment.get("char_start"),
        alignment.get("char_end"),
        alignment.get("text"),
    )


def verify_all(dataset: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Verify every alignment once; the result is small and cached with the bundle."""
    out: dict[str, dict[str, Any]] = {}
    for alignment in dataset.get("alignments", []) or []:
        uid = alignment.get("alignment_uid")
        if not uid:
            continue
        checked = verify_alignment(dataset, alignment)
        out[uid] = {
            "verified": checked["verified"],
            "reason": checked["reason"],
            "claimed": bool(alignment.get("source_verified")),
        }
    return out
