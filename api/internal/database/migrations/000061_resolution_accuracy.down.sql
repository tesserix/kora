ALTER TABLE food_logs
    DROP COLUMN resolution_index,
    DROP COLUMN resolution_outcome_id;

ALTER TABLE food_resolution_outcomes
    DROP COLUMN candidate_food_item_ids,
    DROP COLUMN trace_id;
