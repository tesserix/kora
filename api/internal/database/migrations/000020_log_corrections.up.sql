-- input_phrase is the raw text the user actually said or typed, kept so a
-- later correction can teach the index which phrase resolved wrong.
-- description remains the RESOLVED food's name; these are different fields.
-- Set only for source in ('ai_text','ai_voice'); NULL everywhere else.
ALTER TABLE food_logs ADD COLUMN input_phrase TEXT;

-- user_id scopes a correction alias to the user who made it.
-- NULL means curated/global. No global rows exist today (prod count is 0 and
-- there is no seed data), so this is purely additive.
ALTER TABLE food_aliases ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- A given user's phrase maps to AT MOST ONE food item — enforced here, in
-- the database, not in application code. nutrition.AddAlias upserts against
-- this constraint (ON CONFLICT (user_id, lower(alias)) DO UPDATE) so the
-- latest correction always wins, and two concurrent corrections of the same
-- phrase can never both succeed and leave two competing rows the way a
-- check-then-insert (or a DELETE-then-INSERT in a transaction, which is not
-- a real invariant under READ COMMITTED — two concurrent callers can both
-- see zero rows to delete and both insert) would.
--
-- This single index also serves the lookup that idx_food_aliases_user_alias
-- used to serve (user_id, lower(alias)); keeping both would be pure
-- write/storage cost for the same columns, so that index is not created.
--
-- Postgres treats NULL as DISTINCT from NULL in a unique index, so this does
-- NOT dedupe curated/global rows (user_id IS NULL) — a global phrase could
-- still end up with multiple rows. That is accepted while zero global rows
-- exist in production and no code path writes them.
CREATE UNIQUE INDEX idx_food_aliases_unique ON food_aliases (user_id, lower(alias));
