-- kora#212 Phase 4: record WHICH FOOD CULTURE a row describes.
--
-- `provenance` says which dataset produced a row, `entity_type` (000033) says
-- what kind of thing it is, and neither answers the question that actually
-- matters for an India + Australia user base: is this food from here?
--
-- WHY IT MATTERS, measured: USDA generic reference data is 7,764 rows — 3.4x
-- all Australian and Indian generic data combined (AFCD 1,635 + IFCT 523) — for
-- a user base almost none of it serves. "Chips", "biscuit", "capsicum" and
-- "rocket" all mean different foods in the US, and today the US meaning
-- outnumbers the local one on every query. Locale fixes that as a CLASS rather
-- than term by term.
--
-- LOCALE MUST BOOST, NEVER FILTER. An Australian user eating Indian food is the
-- normal case here, not an edge case, so a filter would break the single most
-- common cross-locale meal. This column only enables a ranking preference.
--
-- Derived, not curated, exactly like entity_type: provenance determines it for
-- every bulk source, so it stays correct for future ingests with no maintenance.
--   afcd -> AU   (FSANZ, measured in Australia)
--   off  -> AU   (off_au.json is filtered to Australian products at conversion)
--   ifct -> IN   (IFCT 2017, measured in India)
--   usda -> US
-- The exception is `curated`, whose file au_in_dishes.json is deliberately
-- MIXED: 46 Indian dishes and 15 Australian ones. Deriving those from
-- provenance would confidently mislabel two thirds of them, so they carry an
-- explicit per-row locale from the source JSON instead. That is the "small
-- amount of genuine data work" kora#212 anticipated.
--
-- Empty string means unknown and is a real state, not a gap to be filled: it
-- means the row gets no locale preference either way, which is the correct
-- treatment for user_estimate rows and for any future source that is not
-- national reference data.
ALTER TABLE food_items ADD COLUMN locale TEXT NOT NULL DEFAULT '';

UPDATE food_items SET locale = 'AU' WHERE provenance IN ('afcd', 'off');
UPDATE food_items SET locale = 'IN' WHERE provenance = 'ifct';
UPDATE food_items SET locale = 'US' WHERE provenance = 'usda';

-- Partial index: only rows WITH a locale are ever filtered on it, and the
-- unknown-locale rows are a small minority that no query selects by.
CREATE INDEX IF NOT EXISTS idx_food_items_locale ON food_items (locale) WHERE locale <> '';
