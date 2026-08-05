-- Admin mutations (slice 2 of the food-data admin design).
--
-- deleted_at exists because a HARD delete is destructive in three ways the
-- food_logs FK does not show. Verified against the live schema:
--   food_aliases.food_item_id      ON DELETE CASCADE  -- destroys a user's taught
--                                                     -- corrections (issue #20)
--   pins.food_item_id              ON DELETE CASCADE
--   saved_meal_items.food_item_id  ON DELETE CASCADE  -- can gut a saved meal
--   food_logs.food_item_id         ON DELETE SET NULL -- log survives, orphaned
-- Every read path must therefore filter deleted_at IS NULL, including the
-- kora_food_index_* gauges, or retired rows silently keep being counted.
ALTER TABLE food_items ADD COLUMN deleted_at timestamptz NULL;
ALTER TABLE food_items ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Partial index: every read path filters deleted_at IS NULL, and retired rows
-- are expected to be a tiny minority, so indexing only the live rows keeps the
-- index small and matches the predicate the queries actually carry.
CREATE INDEX idx_food_items_live ON food_items (id) WHERE deleted_at IS NULL;

-- kora_admin_events is written INSIDE the transaction that performs the
-- mutation, so an audit row cannot go missing when the write succeeds.
-- actor_* come from the BFF-verified identity on the Gin context, never from
-- the request body.
CREATE TABLE kora_admin_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     text        NOT NULL,
    actor_email  text        NOT NULL,
    action       text        NOT NULL,
    target_type  text        NOT NULL,
    target_id    uuid        NULL,
    before       jsonb       NULL,
    after        jsonb       NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kora_admin_events_created ON kora_admin_events (created_at DESC);
CREATE INDEX idx_kora_admin_events_target ON kora_admin_events (target_id, created_at DESC);
