CREATE TABLE saved_meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    meal_slot TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_saved_meals_user ON saved_meals (user_id);

CREATE TABLE saved_meal_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saved_meal_id UUID NOT NULL REFERENCES saved_meals(id) ON DELETE CASCADE,
    food_item_id UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
    grams DOUBLE PRECISION NOT NULL,
    position INT NOT NULL
);
CREATE INDEX ix_saved_meal_items_meal ON saved_meal_items (saved_meal_id);
