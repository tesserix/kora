-- Onboarding has only ever written weight to users.weight_kg -- the number
-- a user typed during onboarding never became a real weigh-in
-- (weight_entries row). The Trends screen's weight card fell back to
-- profile.weight_kg for its hero figure while the panel below it correctly
-- said "No weigh-ins yet" -- two true statements that contradict each other.
-- The product decision: the onboarding weight IS the user's real weight, so
-- it gets a real weigh-in. Going forward onboarding.Handler.Submit writes
-- one directly; this migration backfills it for every profile that already
-- exists. See kora#45 and kora#314.
--
-- Dated at the PROFILE'S OWN created_at, not now(): the reading is as old as
-- the profile. Backfilling with now() would place a months-old weight on
-- today's chart, which the trend graph would show as a fabricated recent
-- data point.
--
-- local_date is derived from that same instant using the user's own
-- timezone column -- the same approach 000032_local_day's backfill used for
-- exactly this reason.
--
-- Every body-composition column is left at its default (NULL): an
-- onboarding weight is a stated number, not an instrument reading, so
-- source is 'manual' and nothing else is claimed as measured. See
-- 000039_body_composition and internal/tracking/model.go.
--
-- Only entry-less profiles get a row (NOT EXISTS), and a user's own
-- backfilled row satisfies that guard on any later run of this file, so
-- re-running it is a no-op the second time -- safe to re-run, including
-- against a database this already ran on.
INSERT INTO weight_entries (user_id, logged_at, weight_kg, local_date, source, created_at)
SELECT
    u.id,
    u.created_at,
    u.weight_kg,
    (u.created_at AT TIME ZONE u.timezone)::date,
    'manual',
    u.created_at
FROM users u
WHERE u.weight_kg > 0
  AND NOT EXISTS (
      SELECT 1 FROM weight_entries we WHERE we.user_id = u.id
  );
