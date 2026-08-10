-- Food unit support. Units are an ENTRY AND DISPLAY concern only: a unit
-- resolves to quantity_grams once at write time and is never re-resolved on
-- read, so correcting a density or serving mass later changes future logs
-- only and never silently rewrites what a past day's totals said.
--
-- base_unit is the unit the row's *_per_100g figures are actually per-100 OF.
-- OpenFoodFacts reports a liquid's nutriments per 100 ml already, so this is a
-- labelling fix, not a numeric conversion. The existing column names stay as
-- they are; renaming kcal_per_100g to something unit-neutral would touch every
-- service and buy nothing.
ALTER TABLE food_items ADD COLUMN base_unit text NOT NULL DEFAULT 'g';
ALTER TABLE food_items ADD CONSTRAINT food_items_base_unit_check
  CHECK (base_unit IN ('g', 'ml'));

-- Named servings, e.g. [{"name":"sachet","amount":1,"base_amount":16.5}].
-- base_amount is expressed in the row's own base_unit. `amount` is the count
-- the name refers to (almost always 1) so "2 biscuits (30g)" parses without
-- lying about what one biscuit weighs.
ALTER TABLE food_items ADD COLUMN serving_units jsonb NOT NULL DEFAULT '[]'::jsonb;

-- What the user actually entered, beside the canonical grams. NULL means a
-- legacy gram-entered row. quantity_grams keeps its exact current meaning and
-- remains the sole input to every nutrition total.
ALTER TABLE food_logs ADD COLUMN entered_amount numeric NULL;
ALTER TABLE food_logs ADD COLUMN entered_unit text NULL;

ALTER TABLE saved_meal_items ADD COLUMN entered_amount numeric NULL;
ALTER TABLE saved_meal_items ADD COLUMN entered_unit text NULL;
