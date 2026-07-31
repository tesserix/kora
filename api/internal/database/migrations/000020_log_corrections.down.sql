DROP INDEX IF EXISTS idx_food_aliases_unique;
ALTER TABLE food_aliases DROP COLUMN user_id;
ALTER TABLE food_logs DROP COLUMN input_phrase;
