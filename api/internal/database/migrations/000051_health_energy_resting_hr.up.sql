-- kora#372. Active energy and resting heart rate join steps, sleep and
-- workouts on the existing daily table. See 000040 for why this is a
-- day-shaped table rather than a table of discrete samples: the coach's
-- context is day-shaped, and neither metric needs intraday resolution.
--
-- Resting heart rate, not heart rate. HKQuantityTypeIdentifierRestingHeartRate
-- is its own HealthKit type and the one that tracks fitness and recovery; a
-- daily average of all-day heart rate would be close to meaningless.
--
-- Both columns are nullable, matching steps/sleep_minutes/workout_minutes:
-- a day with only some metrics synced must not collapse the missing ones
-- into zero.
ALTER TABLE health_daily_summaries
    ADD COLUMN active_energy_kcal INTEGER,
    ADD COLUMN resting_heart_rate_bpm INTEGER;

ALTER TABLE health_daily_summaries
    ADD CONSTRAINT health_daily_summaries_active_energy_check
        CHECK (active_energy_kcal IS NULL OR active_energy_kcal >= 0),
    ADD CONSTRAINT health_daily_summaries_resting_heart_rate_check
        CHECK (resting_heart_rate_bpm IS NULL
            OR resting_heart_rate_bpm BETWEEN 20 AND 250);

-- The existing has_metric_check requires at least one of steps/sleep/workout
-- to be present. A day carrying only active energy or only resting heart
-- rate (both real HealthKit scenarios -- a user who has an Apple Watch but
-- never logs a workout, say) would otherwise be silently rejected. Widen the
-- check to match, rather than leave a day-shaped row that can genuinely
-- happen unrepresentable.
ALTER TABLE health_daily_summaries
    DROP CONSTRAINT health_daily_summaries_has_metric_check;

ALTER TABLE health_daily_summaries
    ADD CONSTRAINT health_daily_summaries_has_metric_check
        CHECK (
            steps IS NOT NULL OR sleep_minutes IS NOT NULL
            OR workout_minutes IS NOT NULL OR active_energy_kcal IS NOT NULL
            OR resting_heart_rate_bpm IS NOT NULL
        );

-- Consent flags on mentor_profiles, opt-in like the three already there
-- (see 000040 line 12).
ALTER TABLE mentor_profiles
    ADD COLUMN health_energy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN health_heart_rate_enabled BOOLEAN NOT NULL DEFAULT FALSE;
