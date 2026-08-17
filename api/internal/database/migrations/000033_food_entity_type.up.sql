-- What KIND of thing a food_items row is, as opposed to where it came from.
--
-- `provenance` answers "which dataset produced this", which is a question about
-- trust and lineage. It is not the same question as "is this a specific packaged
-- item on a shelf, or a reference figure for a food in general" — and the
-- resolver has been inferring the latter from name shape and brand-string
-- similarity, which is guesswork. This column states it.
--
-- VALUE SET — deliberately two values, not a taxonomy:
--   generic          a reference figure for a food, not for one seller's version
--                    of it (USDA, AFCD, hand-authored dishes, user estimates)
--   branded_product  one specific packaged retail item (everything from
--                    OpenFoodFacts, plus the hand-authored AU products)
--
-- A third value ('dish') was considered and rejected for now. Nothing consumes
-- it yet, and — decisively — it is not derivable from the data we hold: the
-- dishes live in `curated` and `user_estimate` (dal, spaghetti bolognese, flat
-- white) but USDA and AFCD carry composite dishes too, so any derivation would
-- really be encoding "hand-authored", which `provenance` already says. A value
-- whose stated meaning differs from what the rule actually tests is worse than
-- no value at all. Add it when something curates it or consumes it.
--
-- DERIVATION RULE, in one sentence: a row is `branded_product` when it
-- identifies one specific packaged item — it carries a barcode or a non-empty
-- brand — and `generic` otherwise.
--
-- Note the barcode half is load-bearing, not belt-and-braces. 80 OpenFoodFacts
-- rows have an empty brand but a real barcode ("Gala Apple", "wafer crackers"):
-- they ARE retail products whose brand field OFF left blank, and a brand-only
-- rule would have mislabelled every one of them as generic reference data.
-- Keeping the rule on the row's own columns rather than on `provenance` also
-- means a future label_ocr row — scanned off a package, so it has a barcode but
-- possibly no brand string — types itself correctly with no rule change.
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'generic';

-- Backfill. Idempotent by construction: the predicate reads only immutable
-- identity columns, so re-running assigns exactly the same rows the same value.
-- It is also safe to re-run against the fully embedded dev index (kora#151) —
-- it touches one text column and no embedding, name or nutrition figure.
--
-- MEASURED SIDE EFFECT, stated here so the next backfill's author is not
-- surprised by it. Rewriting a row moves it in the heap, and the full-text tier
-- in Repository.Resolve orders by similarity() alone — a score that ties across
-- dozens of rows for a common word like "chicken" — so which of the tied rows
-- survives its LIMIT is decided by physical scan order. Backfilling therefore
-- reshuffles tied candidates. Measured on the dev index: every match_score,
-- match_tier and tier decision at every rank position was byte-identical
-- before and after; only WHICH equally-scoring row sat in a slot changed.
-- This is not specific to this migration and is not avoidable by writing the
-- UPDATE differently — an unpredicated whole-table backfill was measured and
-- reshuffles too. It is a property of ordering by a tie-heavy score with no
-- tiebreaker, and the fix, if it is ever wanted, belongs in that ORDER BY.
UPDATE food_items
   SET entity_type = 'branded_product'
 WHERE entity_type <> 'branded_product'
   AND (barcode IS NOT NULL OR btrim(brand) <> '');

-- Validated immediately, unlike 000029's NOT VALID food_logs_source_check. That
-- constraint had to tolerate historical rows written before there was a rule;
-- here the backfill three statements up leaves the table provably clean, so
-- deferring validation would only leave a gap for no gain.
DO $$
BEGIN
    ALTER TABLE food_items
        ADD CONSTRAINT food_items_entity_type_check
        CHECK (entity_type IN ('generic', 'branded_product'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;
