-- ai_usage_events previously recorded a call ONLY when it succeeded, so a
-- failed provider call left no trace at all and COGS was a one-directional
-- undercount (#81). Recording failures makes "call happened" and "call
-- succeeded" different questions, so the outcome has to be stored to keep
-- them apart -- otherwise adding failure rows would silently corrupt every
-- existing cost query instead of fixing it.
--
-- 'ok' as the default is deliberate: every row written before this migration
-- was, by construction, a successful call.
ALTER TABLE ai_usage_events
    ADD COLUMN outcome text NOT NULL DEFAULT 'ok';

-- Cost queries must be able to exclude failures cheaply, and #43's exporter
-- groups by it. Partial index on the failures because they are the minority
-- and the interesting case.
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_outcome
    ON ai_usage_events (outcome)
    WHERE outcome <> 'ok';
