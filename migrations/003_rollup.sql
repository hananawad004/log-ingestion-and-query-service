-- Pre-aggregated rollup table for fast time-bucketed counts. Maintained
-- incrementally on every ingest (see insertBatch), at 1-minute granularity
-- per (service, level). Larger buckets (5m, 1h, 1d) are computed by
-- re-bucketing rows from this table at query time, which is dramatically
-- cheaper than scanning the raw `logs` table.
--
-- Only used for aggregate queries with no attr.* or q= filter (attribute
-- values and message text aren't captured here, since indexing every
-- attribute/message combination defeats the purpose of a small rollup).
-- Those queries fall back to scanning `logs` directly (unchanged behavior).

CREATE TABLE IF NOT EXISTS logs_rollup_1m (
                                              bucket_start TIMESTAMPTZ NOT NULL,
                                              service      TEXT NOT NULL,
                                              level        TEXT NOT NULL,
                                              count        BIGINT NOT NULL DEFAULT 0,
                                              PRIMARY KEY (bucket_start, service, level)
    );

CREATE INDEX IF NOT EXISTS idx_rollup_1m_bucket ON logs_rollup_1m (bucket_start);