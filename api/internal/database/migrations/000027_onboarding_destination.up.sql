-- Onboarding gains a destination: where the user is headed, how fast, and the
-- date that implies. Nullable with no default so existing rows read as "no
-- destination set", which is also what a maintenance user stores.
ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_weight_kg DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pace_kg_per_week DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_date DATE;
