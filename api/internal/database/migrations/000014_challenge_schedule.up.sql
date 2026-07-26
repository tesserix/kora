ALTER TABLE challenges ADD COLUMN started_notified_at TIMESTAMPTZ;
ALTER TABLE challenges ADD COLUMN ended_notified_at TIMESTAMPTZ;
ALTER TABLE challenge_participants ADD COLUMN last_rank INTEGER;
