-- Reverses 000051_health_energy_resting_hr.up.sql (kora#372).
ALTER TABLE mentor_profiles
    DROP COLUMN IF EXISTS health_energy_enabled,
    DROP COLUMN IF EXISTS health_heart_rate_enabled;

ALTER TABLE health_daily_summaries
    DROP CONSTRAINT IF EXISTS health_daily_summaries_has_metric_check;

ALTER TABLE health_daily_summaries
    ADD CONSTRAINT health_daily_summaries_has_metric_check
        CHECK (steps IS NOT NULL OR sleep_minutes IS NOT NULL OR workout_minutes IS NOT NULL);

ALTER TABLE health_daily_summaries
    DROP CONSTRAINT IF EXISTS health_daily_summaries_active_energy_check,
    DROP CONSTRAINT IF EXISTS health_daily_summaries_resting_heart_rate_check;

ALTER TABLE health_daily_summaries
    DROP COLUMN IF EXISTS active_energy_kcal,
    DROP COLUMN IF EXISTS resting_heart_rate_bpm;
