CREATE TABLE pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
    grams DOUBLE PRECISION NOT NULL,
    meal_slot TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, food_item_id)
);
CREATE INDEX ix_pins_user ON pins (user_id);
