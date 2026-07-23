-- User onboarding columns
ALTER TABLE users
    ADD COLUMN sex TEXT NOT NULL DEFAULT '',
    ADD COLUMN birth_year INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN height_cm DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN activity_level TEXT NOT NULL DEFAULT '',
    ADD COLUMN goal TEXT NOT NULL DEFAULT '',
    ADD COLUMN target_kcal DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_protein_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_carbs_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN target_fat_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN onboarded_at TIMESTAMPTZ;

CREATE TABLE food_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    provenance TEXT NOT NULL,               -- afcd | off | usda | label_ocr | user_estimate
    barcode TEXT,
    serving_desc TEXT NOT NULL DEFAULT '',
    serving_grams DOUBLE PRECISION NOT NULL DEFAULT 0,
    kcal_per_100g DOUBLE PRECISION NOT NULL,
    protein_per_100g DOUBLE PRECISION NOT NULL,
    carbs_per_100g DOUBLE PRECISION NOT NULL,
    fat_per_100g DOUBLE PRECISION NOT NULL,
    fiber_per_100g DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_items_name ON food_items USING gin (to_tsvector('simple', name));
CREATE INDEX idx_food_items_name_trgm ON food_items (lower(name));
CREATE UNIQUE INDEX idx_food_items_barcode ON food_items (barcode) WHERE barcode IS NOT NULL;

CREATE TABLE food_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias TEXT NOT NULL,
    food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_aliases_alias ON food_aliases (lower(alias));

CREATE TABLE food_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_item_id UUID REFERENCES food_items(id) ON DELETE SET NULL,
    logged_at TIMESTAMPTZ NOT NULL,
    meal_slot TEXT NOT NULL,                -- breakfast | lunch | dinner | snack
    source TEXT NOT NULL,                   -- manual | barcode | photo | chat | voice
    description TEXT NOT NULL DEFAULT '',
    quantity_grams DOUBLE PRECISION NOT NULL,
    kcal DOUBLE PRECISION NOT NULL,
    protein_g DOUBLE PRECISION NOT NULL,
    carbs_g DOUBLE PRECISION NOT NULL,
    fat_g DOUBLE PRECISION NOT NULL,
    fiber_g DOUBLE PRECISION NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL,               -- copied from food_item or 'user_estimate'
    client_log_ms INTEGER,                  -- client-measured time-to-log (success metric)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_food_logs_user_logged ON food_logs (user_id, logged_at);

CREATE TABLE water_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_at TIMESTAMPTZ NOT NULL,
    volume_ml INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_water_entries_user_logged ON water_entries (user_id, logged_at);

CREATE TABLE weight_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_at TIMESTAMPTZ NOT NULL,
    weight_kg DOUBLE PRECISION NOT NULL,
    body_fat_pct DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_weight_entries_user_logged ON weight_entries (user_id, logged_at);
