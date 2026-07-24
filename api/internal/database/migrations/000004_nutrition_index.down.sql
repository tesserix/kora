DROP INDEX IF EXISTS idx_food_items_embedding;
DROP INDEX IF EXISTS idx_food_items_normalized_name;
ALTER TABLE food_items
    DROP COLUMN IF EXISTS normalized_name,
    DROP COLUMN IF EXISTS embedding;
-- Leave the `vector` extension installed (other objects may use it).
