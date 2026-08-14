-- kora#84. A log's day is a fact about when it was eaten, decided once at
-- capture. Previously the day boundary was derived at QUERY time from the
-- user's CURRENT profile timezone, so changing that timezone silently
-- re-bucketed all history: fly Sydney -> London and yesterday's dinner moved
-- to a different day.
--
-- The backfill uses the profile timezone precisely because that is what the
-- old query-time logic used, so existing rows land in the buckets they already
-- appear in. Zero visible change to existing data -- which is what makes
-- SET NOT NULL safe here, rather than a nullable column plus a fallback path
-- maintained forever.

ALTER TABLE food_logs ADD COLUMN local_date DATE;
ALTER TABLE water_entries ADD COLUMN local_date DATE;
ALTER TABLE weight_entries ADD COLUMN local_date DATE;

UPDATE food_logs fl
SET local_date = (fl.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = fl.user_id;

UPDATE water_entries we
SET local_date = (we.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = we.user_id;

UPDATE weight_entries we
SET local_date = (we.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = we.user_id;

-- A row whose user no longer exists cannot be bucketed from a profile zone.
-- Fall back to UTC rather than leaving a NULL that would block SET NOT NULL.
UPDATE food_logs SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;
UPDATE water_entries SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;
UPDATE weight_entries SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;

ALTER TABLE food_logs ALTER COLUMN local_date SET NOT NULL;
ALTER TABLE water_entries ALTER COLUMN local_date SET NOT NULL;
ALTER TABLE weight_entries ALTER COLUMN local_date SET NOT NULL;

CREATE INDEX idx_food_logs_user_local_date ON food_logs (user_id, local_date);
CREATE INDEX idx_water_entries_user_local_date ON water_entries (user_id, local_date);
CREATE INDEX idx_weight_entries_user_local_date ON weight_entries (user_id, local_date);

-- NOT NULL is not enough on its own. Go's zero time.Time marshals to
-- 0001-01-01, which Postgres accepts as a perfectly valid DATE -- so a writer
-- that forgets to set local_date passes the NOT NULL check and stores year 1.
-- Such a row matches no day query and is silently invisible forever, which is
-- a far worse failure than a rejected write. These CHECKs make that mistake
-- loud at the moment it happens.
ALTER TABLE food_logs ADD CONSTRAINT food_logs_local_date_plausible
  CHECK (local_date > DATE '2000-01-01');
ALTER TABLE water_entries ADD CONSTRAINT water_entries_local_date_plausible
  CHECK (local_date > DATE '2000-01-01');
ALTER TABLE weight_entries ADD CONSTRAINT weight_entries_local_date_plausible
  CHECK (local_date > DATE '2000-01-01');
