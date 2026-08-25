"""Append-only review event store.

Extraction output is never modified. Every human decision is a new row; the
current state of a review item is the fold of its rows (last one wins) and is
computed on read. There is no UPDATE and no DELETE anywhere in this module.

Default backend is SQLite (stdlib, transactional, one file next to the data).
``REVIEW_DATABASE_URL=postgresql://...`` switches to Postgres when psycopg is
installed; the DDL is in ``schema/events_postgres.sql`` and the row shape is
identical, so events exported from SQLite import straight into it.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .config import settings

DECISIONS = ("accepted", "rejected", "corrected", "deferred")

SQLITE_DDL = """
CREATE TABLE IF NOT EXISTS review_events (
    review_event_uid  TEXT PRIMARY KEY,
    dataset_id        TEXT NOT NULL,
    dataset_revision  TEXT NOT NULL,
    schema_version    TEXT,
    review_item_uid   TEXT NOT NULL,
    item_type         TEXT,
    entity_uid        TEXT,
    decision          TEXT NOT NULL,
    corrected_value   TEXT,
    reviewer_id       TEXT NOT NULL,
    reviewed_at       TEXT NOT NULL,
    comment           TEXT,
    idempotency_key   TEXT,
    client            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS review_events_idem
    ON review_events (dataset_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_events_item
    ON review_events (dataset_id, review_item_uid, reviewed_at);
CREATE INDEX IF NOT EXISTS review_events_dataset
    ON review_events (dataset_id, reviewed_at);
"""

COLUMNS = (
    "review_event_uid", "dataset_id", "dataset_revision", "schema_version",
    "review_item_uid", "item_type", "entity_uid", "decision", "corrected_value",
    "reviewer_id", "reviewed_at", "comment", "idempotency_key", "client",
)


class DuplicateEvent(Exception):
    """Idempotency key already used; carries the event that was stored first."""

    def __init__(self, event: dict[str, Any]):
        super().__init__(event.get("review_event_uid", "duplicate"))
        self.event = event


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    event = {key: row[key] for key in COLUMNS}
    if event["corrected_value"]:
        try:
            event["corrected_value"] = json.loads(event["corrected_value"])
        except json.JSONDecodeError:
            pass
    return event


class SqliteEventStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._local = threading.local()
        with self._connect() as conn:
            conn.executescript(SQLITE_DDL)

    def _connect(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            self._local.conn = conn
        return conn

    # ------------------------------------------------------------- writes

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        payload = dict(event)
        payload.setdefault("review_event_uid", f"REV_{uuid.uuid4().hex[:20].upper()}")
        payload.setdefault("reviewed_at", _now())
        stored = dict(payload)
        stored["corrected_value"] = (
            json.dumps(payload.get("corrected_value"), ensure_ascii=False)
            if payload.get("corrected_value") is not None
            else None
        )
        columns = ", ".join(COLUMNS)
        placeholders = ", ".join("?" for _ in COLUMNS)
        with self._lock:
            conn = self._connect()
            if payload.get("idempotency_key"):
                existing = conn.execute(
                    "SELECT * FROM review_events WHERE dataset_id = ? AND idempotency_key = ?",
                    (payload["dataset_id"], payload["idempotency_key"]),
                ).fetchone()
                if existing is not None:
                    raise DuplicateEvent(_row_to_event(existing))
            conn.execute(
                f"INSERT INTO review_events ({columns}) VALUES ({placeholders})",
                tuple(stored.get(column) for column in COLUMNS),
            )
            conn.commit()
        return payload

    # -------------------------------------------------------------- reads

    def list(self, dataset_id: str, review_item_uid: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM review_events WHERE dataset_id = ?"
        params: list[Any] = [dataset_id]
        if review_item_uid:
            query += " AND review_item_uid = ?"
            params.append(review_item_uid)
        query += " ORDER BY reviewed_at ASC, rowid ASC"
        conn = self._connect()
        return [_row_to_event(row) for row in conn.execute(query, params)]

    def current(self, dataset_id: str) -> dict[str, dict[str, Any]]:
        """Fold events into the present state of each review item."""
        state: dict[str, dict[str, Any]] = {}
        for event in self.list(dataset_id):
            item = event["review_item_uid"]
            entry = state.setdefault(item, {"review_item_uid": item, "events": 0})
            entry.update(
                {
                    "decision": event["decision"],
                    "corrected_value": event["corrected_value"],
                    "reviewer_id": event["reviewer_id"],
                    "reviewed_at": event["reviewed_at"],
                    "comment": event["comment"],
                    "review_event_uid": event["review_event_uid"],
                    "dataset_revision": event["dataset_revision"],
                    "events": entry["events"] + 1,
                }
            )
        return state

    def stats(self, dataset_id: str) -> dict[str, Any]:
        current = self.current(dataset_id)
        by_decision: dict[str, int] = {}
        entities: set[str] = set()
        for item_uid, entry in current.items():
            by_decision[entry["decision"]] = by_decision.get(entry["decision"], 0) + 1
            entities.add(item_uid)
        conn = self._connect()
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM review_events WHERE dataset_id = ?", (dataset_id,)
        ).fetchone()["n"]
        return {"events": total, "decided_items": len(current), "by_decision": by_decision, "items": sorted(entities)}

    def export_jsonl(self, dataset_id: str) -> Iterable[str]:
        for event in self.list(dataset_id):
            yield json.dumps(event, ensure_ascii=False) + "\n"


def build_store() -> SqliteEventStore:
    url = settings.database_url
    if url.startswith("sqlite:///"):
        return SqliteEventStore(Path(url[len("sqlite:///") :]))
    raise RuntimeError(
        f"unsupported REVIEW_DATABASE_URL: {url!r}. "
        "SQLite is built in; for Postgres apply schema/events_postgres.sql and add a store class."
    )


store = build_store()
