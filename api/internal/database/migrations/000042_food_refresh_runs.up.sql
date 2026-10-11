-- Record of weekly OpenFoodFacts refresh passes (internal/nutrition/refresh).
--
-- The table IS the schedule: a pass is due when the newest successful row is
-- older than the cadence. That makes the weekly refresh restart-safe with no
-- in-process clock state, and replica-safe together with the advisory lock —
-- the losing replica re-reads this table inside the lock and stands down.
CREATE TABLE IF NOT EXISTS food_refresh_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    since TIMESTAMPTZ NOT NULL,
    files_read INT NOT NULL DEFAULT 0,
    seen INT NOT NULL DEFAULT 0,
    inserted INT NOT NULL DEFAULT 0,
    updated INT NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
);

-- The one query the scheduler runs: newest successful pass.
CREATE INDEX IF NOT EXISTS idx_food_refresh_runs_success
    ON food_refresh_runs (started_at DESC)
    WHERE finished_at IS NOT NULL AND error = '';
