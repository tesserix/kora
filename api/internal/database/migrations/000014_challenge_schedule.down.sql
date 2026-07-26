ALTER TABLE challenge_participants DROP COLUMN IF EXISTS last_rank;
ALTER TABLE challenges DROP COLUMN IF EXISTS ended_notified_at;
ALTER TABLE challenges DROP COLUMN IF EXISTS started_notified_at;
