-- input_phrase is the raw text the user actually said or typed, kept so a
-- later correction can teach the index which phrase resolved wrong.
-- description remains the RESOLVED food's name; these are different fields.
-- Set only for source in ('ai_text','ai_voice'); NULL everywhere else.
ALTER TABLE food_logs ADD COLUMN input_phrase TEXT;

-- user_id scopes a correction alias to the user who made it.
-- NULL means curated/global. No global rows exist today (prod count is 0 and
-- there is no seed data), so this is purely additive.
ALTER TABLE food_aliases ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_food_aliases_user_alias ON food_aliases (user_id, lower(alias));

-- Replaces the check-then-insert race in nutrition.AddAlias with a real
-- constraint. Postgres treats NULL user_id as distinct per row, so this does
-- NOT dedupe global aliases — acceptable while zero exist, and cheaper than
-- NULLS NOT DISTINCT for a case that does not occur.
CREATE UNIQUE INDEX idx_food_aliases_unique ON food_aliases (user_id, lower(alias), food_item_id);
