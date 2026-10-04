-- The trace and ranked candidates a confirmation is scored against (kora#556).
ALTER TABLE food_resolution_outcomes
    ADD COLUMN trace_id TEXT,
    ADD COLUMN candidate_food_item_ids UUID[] NOT NULL DEFAULT '{}';

-- The resolution item a log confirmed; a later edit re-scores that same item.
ALTER TABLE food_logs
    ADD COLUMN resolution_outcome_id UUID REFERENCES food_resolution_outcomes(id) ON DELETE SET NULL,
    ADD COLUMN resolution_index SMALLINT;
