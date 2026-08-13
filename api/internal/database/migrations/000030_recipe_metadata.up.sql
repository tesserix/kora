-- Tags are a SET: the composite primary key enforces per-recipe de-duplication
-- in the database rather than in application code, and needs no surrogate id.
-- There is deliberately no position column.
CREATE TABLE recipe_tags (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);

-- Carries both the ?tags= filter and the tag-list-with-counts query.
CREATE INDEX ix_recipe_tags_tag ON recipe_tags (tag);

-- Steps are a SEQUENCE: order IS the meaning, so the key is (recipe_id,
-- position), not (recipe_id, text). Two identical instructions at different
-- points in a method are legitimate and must both survive.
CREATE TABLE recipe_steps (
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    text      TEXT NOT NULL,
    PRIMARY KEY (recipe_id, position)
);
