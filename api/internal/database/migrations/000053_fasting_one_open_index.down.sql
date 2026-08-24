-- Restoring the index can fail if any user already has more than one row with
-- ended_at IS NULL, which is legal after the up migration. That is expected:
-- the down direction is only usable on data the old invariant still fits.
CREATE UNIQUE INDEX IF NOT EXISTS fasting_intervals_one_open
    ON fasting_intervals (user_id) WHERE ended_at IS NULL;
