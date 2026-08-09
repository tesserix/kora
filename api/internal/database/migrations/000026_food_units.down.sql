-- Lossless: quantity_grams was never modified by the up migration, so every
-- nutrition total survives this rollback unchanged. What IS lost is the record
-- of what the user typed — a log entered as "1 sachet" reverts to reading as
-- its gram equivalent, which is exactly the pre-000026 behaviour.
ALTER TABLE saved_meal_items DROP COLUMN IF EXISTS entered_unit;
ALTER TABLE saved_meal_items DROP COLUMN IF EXISTS entered_amount;

ALTER TABLE food_logs DROP COLUMN IF EXISTS entered_unit;
ALTER TABLE food_logs DROP COLUMN IF EXISTS entered_amount;

ALTER TABLE food_items DROP CONSTRAINT IF EXISTS food_items_base_unit_check;
ALTER TABLE food_items DROP COLUMN IF EXISTS serving_units;
ALTER TABLE food_items DROP COLUMN IF EXISTS base_unit;
