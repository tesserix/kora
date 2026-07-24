-- Global monthly SUM and per-user COUNT in billing.WithinBudget filter on
-- created_at; a plain created_at index avoids a seq scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events (created_at);
