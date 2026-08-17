-- Make a curated/global food alias idempotent to import (kora#212 item 2).
--
-- idx_food_aliases_unique covers (user_id, lower(alias)), which does NOT
-- constrain global rows: Postgres treats NULL as DISTINCT from NULL in a unique
-- index, so `ON CONFLICT (user_id, lower(alias))` never fires when user_id IS
-- NULL. Three identical global AddAlias calls produce three duplicate rows —
-- verified empirically, and documented on Repository.AddAlias.
--
-- That was tolerable while nothing wrote global aliases (only tests did). It
-- stops being tolerable the moment they are imported from a data file, because
-- every re-run of cmd/ingest would duplicate the whole set, and Resolve's
-- global-alias query applies LIMIT — so duplicates consume result slots and
-- genuinely distinct aliases sorted after the cutoff would be silently missed.
--
-- A partial unique index constrains exactly the rows the existing one cannot,
-- and gives ON CONFLICT a target to name. One global alias therefore maps to
-- exactly ONE food, which is the right semantics for a translation layer: if
-- two rows both claim "brinjal", that is a conflict to resolve at import time,
-- not an ambiguity to leave in the table.
--
-- Safe to add: food_aliases is empty in dev and prod as of 2026-08-18, so there
-- are no existing duplicates for this to fail on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_aliases_global_unique
    ON food_aliases (lower(alias))
    WHERE user_id IS NULL;
