ALTER TABLE food_logs DROP CONSTRAINT IF EXISTS food_logs_local_date_plausible;
ALTER TABLE water_entries DROP CONSTRAINT IF EXISTS water_entries_local_date_plausible;
ALTER TABLE weight_entries DROP CONSTRAINT IF EXISTS weight_entries_local_date_plausible;

DROP INDEX IF EXISTS idx_food_logs_user_local_date;
DROP INDEX IF EXISTS idx_water_entries_user_local_date;
DROP INDEX IF EXISTS idx_weight_entries_user_local_date;

ALTER TABLE food_logs DROP COLUMN IF EXISTS local_date;
ALTER TABLE water_entries DROP COLUMN IF EXISTS local_date;
ALTER TABLE weight_entries DROP COLUMN IF EXISTS local_date;
