-- Postgres has no "INVALIDATE CONSTRAINT", so returning food_logs_source_check
-- to NOT VALID means dropping and re-adding it exactly as 000029 did.
--
-- The re-add is intentionally identical to 000029's, including NOT VALID, so
-- that rolling back to 000033 leaves the schema in the state 000033 expects
-- rather than one where the constraint has silently vanished. Dropping without
-- re-adding would remove the guard on future writes, which is a bigger change
-- than this migration ever made.
ALTER TABLE food_logs DROP CONSTRAINT IF EXISTS food_logs_source_check;

ALTER TABLE food_logs
    ADD CONSTRAINT food_logs_source_check
    CHECK (source IN (
        'ai_photo', 'ai_text', 'ai_voice', 'ai_barcode',
        'manual', 'memory', 'meal', 'recipe'
    )) NOT VALID;
