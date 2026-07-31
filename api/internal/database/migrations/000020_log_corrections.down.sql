DROP INDEX IF EXISTS idx_food_aliases_unique;

-- Dropping user_id (below) would otherwise silently turn every personal
-- correction into a GLOBAL one — food_aliases.user_id simply disappears, so
-- any row it distinguished becomes indistinguishable from a curated/global
-- alias, resolvable to every user. That is the exact cross-user leak this
-- migration exists to fix, and a rollback must not recreate it with real
-- data. Delete personal rows first so a rollback can only ever lose
-- personal corrections, never leak them.
DELETE FROM food_aliases WHERE user_id IS NOT NULL;

ALTER TABLE food_aliases DROP COLUMN user_id;
ALTER TABLE food_logs DROP COLUMN input_phrase;
