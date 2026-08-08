-- #106 decided ai_usage_events is RETAINED when a user is deleted, with
-- user_id set to NULL. The constraint shipped as ON DELETE CASCADE, which
-- silently does the opposite: deleting a user destroys their AI usage
-- history, and with it the "tried but never logged" cohort that the admin
-- activation funnel exists to surface.
--
-- Retention is deliberate and is NOT a privacy regression: user_id becomes
-- NULL, so the surviving rows are anonymous usage counters (call type,
-- outcome, latency) with no link back to a person.
ALTER TABLE ai_usage_events ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_user_id_fkey;
ALTER TABLE ai_usage_events
    ADD CONSTRAINT ai_usage_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
