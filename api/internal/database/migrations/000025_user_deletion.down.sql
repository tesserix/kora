-- Rows orphaned by a deletion cannot be re-attributed, so they are removed
-- before NOT NULL is restored. A down migration that left them would fail on
-- the NOT NULL, and one that invented a user_id would be worse.
DELETE FROM ai_usage_events WHERE user_id IS NULL;

ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_user_id_fkey;
ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ai_usage_events ALTER COLUMN user_id SET NOT NULL;
