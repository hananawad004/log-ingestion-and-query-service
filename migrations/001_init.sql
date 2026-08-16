-- Initial schema for the log ingestion/query service.
--
-- Design notes (full rationale in README):
--   * The table is RANGE partitioned by month on `ts`. Smaller partitions
--     mean smaller indexes (better cache locality on a 1GB Postgres
--     container) and retention becomes a metadata-only DROP TABLE instead
--     of a row-by-row DELETE (no bloat, no long-running locks).
--   * `attributes` is stored as JSONB. Equality filters compare it as text
--     (`attributes ->> key = value`), matching the API contract which
--     always compares attribute values as strings regardless of their
--     original JSON type.
--   * `id` is a BIGINT identity column, included in the sort key together
--     with `ts` so ordering (and keyset pagination) stays deterministic
--     even when many rows share the same timestamp.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS logs (
                                    id          BIGINT GENERATED ALWAYS AS IDENTITY,
                                    ts          TIMESTAMPTZ NOT NULL,
                                    level       TEXT NOT NULL,
                                    service     TEXT NOT NULL,
                                    message     TEXT NOT NULL,
                                    attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
                                    PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts);

-- Catch-all partition: inserts never fail even if the maintenance job
-- hasn't created a partition yet for a given timestamp. A safety net,
-- not the normal path.
CREATE TABLE IF NOT EXISTS logs_default PARTITION OF logs DEFAULT;

-- Indexes created on the partitioned (parent) table are automatically
-- created on every existing partition, and on every future partition
-- attached with CREATE TABLE ... PARTITION OF (PostgreSQL >= 11).

-- Primary access pattern: "most recent logs first". Also backs keyset
-- (cursor) pagination via (ts, id) row comparison.
CREATE INDEX IF NOT EXISTS idx_logs_ts_id ON logs (ts DESC, id DESC);

-- Exact-match filters used on essentially every query.
CREATE INDEX IF NOT EXISTS idx_logs_service ON logs (service);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);

-- Attribute containment lookups.
CREATE INDEX IF NOT EXISTS idx_logs_attributes_gin ON logs USING GIN (attributes jsonb_path_ops);

-- NOTE: A pg_trgm GIN index on `message` was benchmarked and removed from
-- the default schema. It accelerated q= substring search but cost ~35%
-- of write throughput under load (measured: ~10.7K -> ~16.1K logs/sec
-- after removal, p95 latency ~511ms -> ~264ms). Since it is optional
-- and off by default (see ENABLE_MESSAGE_SEARCH_INDEX), it is created
-- programmatically at startup instead of here. See README.

-- Bookkeeping table so the retention/partition-maintenance job knows which
-- monthly partitions exist without querying pg_catalog every run.
CREATE TABLE IF NOT EXISTS log_partitions (
                                              partition_name TEXT PRIMARY KEY,
                                              range_start    TIMESTAMPTZ NOT NULL,
                                              range_end      TIMESTAMPTZ NOT NULL,
                                              created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );