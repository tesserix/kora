CREATE INDEX idx_food_items_normalized_name_fts ON food_items USING gin (to_tsvector('simple', normalized_name));
