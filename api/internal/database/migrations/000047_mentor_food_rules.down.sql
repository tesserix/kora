DROP INDEX IF EXISTS idx_food_items_diet_tags;
ALTER TABLE food_items DROP COLUMN IF EXISTS diet_tags;

ALTER TABLE mentor_profiles DROP CONSTRAINT IF EXISTS mentor_profiles_diet_pattern_check;
ALTER TABLE mentor_profiles DROP COLUMN IF EXISTS diet_pattern;

DROP TABLE IF EXISTS mentor_food_rules;
