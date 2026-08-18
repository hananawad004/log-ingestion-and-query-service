-- Adds a generated column that stringifies every value in `attributes`,
-- indexed with GIN for containment (@>) lookups. This lets attr.<key>
-- equality filters use an index instead of the unindexable `->>` text
-- extraction, while leaving the original `attributes` column (and its
-- original JSON types in API responses) completely untouched.

CREATE OR REPLACE FUNCTION jsonb_stringify_values(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
SELECT COALESCE(
               jsonb_object_agg(key, to_jsonb(value)),
               '{}'::jsonb
       )
FROM jsonb_each_text(j) AS t(key, value)
    $$;

ALTER TABLE logs
    ADD COLUMN IF NOT EXISTS attributes_str jsonb
    GENERATED ALWAYS AS (jsonb_stringify_values(attributes)) STORED;

CREATE INDEX IF NOT EXISTS idx_logs_attributes_str_gin
    ON logs USING GIN (attributes_str jsonb_path_ops);