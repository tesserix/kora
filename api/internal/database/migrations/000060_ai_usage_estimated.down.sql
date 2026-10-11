-- Reverse 000060. See the up migration for why the column exists.
ALTER TABLE ai_usage_events DROP COLUMN IF EXISTS estimated;
