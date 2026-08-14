DROP INDEX IF EXISTS idx_food_logs_user_local_date;
DROP INDEX IF EXISTS idx_water_entries_user_local_date;
DROP INDEX IF EXISTS idx_weight_entries_user_local_date;

ALTER TABLE food_logs DROP COLUMN IF EXISTS local_date;
ALTER TABLE water_entries DROP COLUMN IF EXISTS local_date;
ALTER TABLE weight_entries DROP COLUMN IF EXISTS local_date;
