-- Lossy: rolling back discards the record of which portions were guessed.
-- Every row reverts to reading as a plain figure, indistinguishable from a
-- weighed one — the exact bug #138 exists to fix.
ALTER TABLE food_logs DROP COLUMN IF EXISTS portion_assumed;
