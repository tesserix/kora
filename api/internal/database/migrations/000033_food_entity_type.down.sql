-- Lossless. entity_type is derived — every value it held is recomputable from
-- the barcode and brand columns this migration never touched — so dropping it
-- discards no information the row does not still carry.
ALTER TABLE food_items DROP CONSTRAINT IF EXISTS food_items_entity_type_check;
ALTER TABLE food_items DROP COLUMN IF EXISTS entity_type;
