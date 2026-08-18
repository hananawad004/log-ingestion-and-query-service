-- The original idx_logs_attributes_gin (on `attributes`) became dead
-- weight once attr.* filtering in queryService/aggregateService switched
-- to attributes_str @> containment (migration 002). It was still
-- maintained on every insert with zero read benefit. Dropped here, and
-- the intended index recreated defensively in case an environment never
-- ran the ad-hoc version applied during testing.

CREATE INDEX IF NOT EXISTS idx_logs_attributes_str_gin
    ON logs USING GIN (attributes_str jsonb_path_ops);

DROP INDEX IF EXISTS idx_logs_attributes_gin;