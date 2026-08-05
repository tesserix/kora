DROP INDEX IF EXISTS idx_kora_admin_events_target;
DROP INDEX IF EXISTS idx_kora_admin_events_created;
DROP TABLE IF EXISTS kora_admin_events;
DROP INDEX IF EXISTS idx_food_items_live;
-- Rolling back RESURRECTS every soft-deleted row into all read paths, because
-- the column carrying the retirement disappears. That is the correct and only
-- possible behaviour for a down migration, but it is not a no-op — anything
-- retired while this migration was applied becomes live again.
ALTER TABLE food_items DROP COLUMN IF EXISTS updated_at;
ALTER TABLE food_items DROP COLUMN IF EXISTS deleted_at;
