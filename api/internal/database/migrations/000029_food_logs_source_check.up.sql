-- food_logs.source is written straight from a client-supplied field on both
-- POST /v1/logs and POST /v1/logs/batch, and had no constraint of any kind:
-- an arbitrary string persisted as-is, and an ai_* value written through the
-- batch endpoint produced a correction-eligible row with a NULL input_phrase,
-- violating the invariant 000020_log_corrections.up.sql documents.
--
-- The set mirrors metrics.knownSources, which is the authoritative list (a
-- source outside it buckets to "other" in every dashboard). recipes.source
-- already models this pattern (migration 000028).
--
-- NOT VALID deliberately: this guards every future write immediately without
-- a full-table scan and without failing the migration on any historical row
-- written before there was a rule. Run VALIDATE CONSTRAINT separately once the
-- existing data is known to be clean.
ALTER TABLE food_logs
    ADD CONSTRAINT food_logs_source_check
    CHECK (source IN (
        'ai_photo', 'ai_text', 'ai_voice', 'ai_barcode',
        'manual', 'memory', 'meal', 'recipe'
    )) NOT VALID;
