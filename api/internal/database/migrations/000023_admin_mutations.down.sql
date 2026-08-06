-- DROP TABLE drops its own indexes; the two DROP INDEX lines below are
-- redundant but left in for symmetry with the rest of this file, which
-- explicitly reverses every object the up migration created.
DROP INDEX IF EXISTS idx_kora_admin_events_target;
DROP INDEX IF EXISTS idx_kora_admin_events_created;
DROP TABLE IF EXISTS kora_admin_events;

-- Restore the original index definitions (pre-000023), exactly as created in
-- 000002/000004/000005: same columns, opclasses and method. As of round 2 the
-- up migration no longer makes these partial (see its comment), so this is a
-- straight drop-and-recreate of the identical definition either way.
DROP INDEX IF EXISTS idx_food_items_normalized_name;
CREATE INDEX idx_food_items_normalized_name ON food_items (normalized_name);

DROP INDEX IF EXISTS idx_food_items_name_trgm;
CREATE INDEX idx_food_items_name_trgm ON food_items (lower(name));

DROP INDEX IF EXISTS idx_food_items_name;
CREATE INDEX idx_food_items_name ON food_items USING gin (to_tsvector('simple', name));

DROP INDEX IF EXISTS idx_food_items_normalized_name_fts;
CREATE INDEX idx_food_items_normalized_name_fts ON food_items USING gin (to_tsvector('simple', normalized_name));

DROP INDEX IF EXISTS idx_food_items_embedding;
CREATE INDEX idx_food_items_embedding ON food_items USING hnsw (embedding vector_cosine_ops);

-- Rolling back RESURRECTS every soft-deleted row into all read paths, because
-- the column carrying the retirement disappears. That is the correct and only
-- possible behaviour for a down migration, but it is not a no-op — anything
-- retired while this migration was applied becomes live again.
--
-- It is also lossy the other direction: dropping updated_at and re-applying
-- the up migration re-runs `UPDATE food_items SET updated_at = created_at`,
-- so every genuine edit timestamp accumulated while this migration was
-- applied is overwritten back to created_at. Both losses are inherent to
-- reversing a soft-delete-and-audit migration, not bugs in this file.
ALTER TABLE food_items DROP COLUMN IF EXISTS updated_at;
ALTER TABLE food_items DROP COLUMN IF EXISTS deleted_at;
