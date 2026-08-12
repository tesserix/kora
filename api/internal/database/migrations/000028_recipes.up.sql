CREATE TABLE recipes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    servings   INTEGER NOT NULL CHECK (servings > 0),
    source     TEXT NOT NULL CHECK (source IN ('manual','paste','photo')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_recipes_user ON recipes (user_id, created_at DESC);

-- food_item_id is NULLABLE on purpose: AI extraction regularly produces an
-- ingredient the food index cannot resolve. The recipe still saves, holding
-- that ingredient as raw_text with ZERO macro contribution, surfaced to the
-- user as needing attention. The two failure modes this rules out are
-- silently dropping the ingredient (macros quietly too low, user never told)
-- and fabricating a match (macros wrong, user actively misled).
CREATE TABLE recipe_ingredients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id       UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    food_item_id    UUID NULL REFERENCES food_items(id),
    raw_text        TEXT NOT NULL,
    grams           DOUBLE PRECISION NOT NULL DEFAULT 0,
    entered_amount  DOUBLE PRECISION NULL,
    entered_unit    TEXT NULL,
    -- portion_assumed carries #138's lesson: a guessed portion must stay
    -- LABELLED for the life of the row, not just on the confirm screen. A
    -- recipe is re-logged for months.
    portion_assumed BOOLEAN NOT NULL DEFAULT false,
    -- NULL match_score/match_tier means the USER picked this food, which
    -- carries no model confidence to record. Distinct from a low score.
    match_score     DOUBLE PRECISION NULL,
    match_tier      TEXT NULL
);

CREATE INDEX ix_recipe_ingredients_recipe ON recipe_ingredients (recipe_id, position);
