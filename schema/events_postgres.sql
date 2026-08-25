-- Review event log, Postgres edition.
--
-- Same columns as the SQLite table in app/events.py, so events exported with
-- `GET /api/v1/datasets/{id}/review-events/export.jsonl` import straight into
-- this table. Append-only by convention and by grant: the application role gets
-- INSERT and SELECT, never UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS review_events (
    review_event_uid  TEXT PRIMARY KEY,
    dataset_id        TEXT        NOT NULL,
    dataset_revision  TEXT        NOT NULL,
    schema_version    TEXT,
    review_item_uid   TEXT        NOT NULL,
    item_type         TEXT,
    entity_uid        TEXT,
    decision          TEXT        NOT NULL
        CHECK (decision IN ('accepted', 'rejected', 'corrected', 'deferred')),
    corrected_value   JSONB,
    reviewer_id       TEXT        NOT NULL,
    reviewed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    comment           TEXT,
    idempotency_key   TEXT,
    client            TEXT
);

-- Retry-safe writes: the same Idempotency-Key can only land once per dataset.
CREATE UNIQUE INDEX IF NOT EXISTS review_events_idem
    ON review_events (dataset_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_events_item
    ON review_events (dataset_id, review_item_uid, reviewed_at);

CREATE INDEX IF NOT EXISTS review_events_dataset
    ON review_events (dataset_id, reviewed_at DESC);

-- Current state of every review item = the last event per item.
CREATE OR REPLACE VIEW review_item_state AS
SELECT DISTINCT ON (dataset_id, review_item_uid)
       dataset_id, review_item_uid, decision, corrected_value,
       reviewer_id, reviewed_at, comment, dataset_revision, review_event_uid
FROM   review_events
ORDER  BY dataset_id, review_item_uid, reviewed_at DESC, review_event_uid DESC;

-- GRANT SELECT, INSERT ON review_events TO review_app;
-- GRANT SELECT ON review_item_state TO review_app;
