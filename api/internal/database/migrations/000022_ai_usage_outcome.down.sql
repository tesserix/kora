DROP INDEX IF EXISTS idx_ai_usage_events_outcome;
ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS outcome;
