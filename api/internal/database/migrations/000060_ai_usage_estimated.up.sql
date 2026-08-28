-- kora#376: GeminiProvider.Embed records TokensIn/TokensOut with no way to
-- tell a measured count from a guess. genai.EmbedContentResponse carries no
-- UsageMetadata at all (unlike every other Gemini call), so the only way to
-- stop recording zero tokens for a real embedding call is to ESTIMATE the
-- count from the input text -- and an estimate written into tokens_in with
-- no marker is indistinguishable from a provider-reported measurement. That
-- is the same conflation 'outcome' (migration 000022) was added to end, so
-- it gets the same treatment: a column, not a convention.
--
-- 'false' as the default is deliberate, exactly as 000022 reasoned for
-- outcome: every row written before this migration was, by construction,
-- either a provider-reported count or a genuine zero-token failure. Neither
-- is an estimate.
ALTER TABLE ai_usage_events
    ADD COLUMN estimated BOOLEAN NOT NULL DEFAULT false;
