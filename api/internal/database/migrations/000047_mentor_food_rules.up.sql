-- Structured dietary constraints, replacing enforcement-by-prose. The free-text
-- columns on mentor_profiles stay: they are how a user says something the
-- taxonomy has no token for, and they seed the rules parsed from them.
CREATE TABLE mentor_food_rules (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- Stored, not derived from kind: a religious or ethical exclusion is
    -- absolute for the person who holds it, and deriving would force every
    -- consumer to re-implement the mapping.
    severity TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    -- NULL means proposed and not in force. Nothing enforces until the user
    -- confirms it, which keeps mentor context "user-confirmed" as documented.
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mentor_food_rules_subject_check CHECK (char_length(btrim(subject)) BETWEEN 1 AND 60),
    CONSTRAINT mentor_food_rules_kind_check CHECK (kind IN ('allergy', 'exclusion', 'preference')),
    CONSTRAINT mentor_food_rules_severity_check CHECK (severity IN ('block', 'flag')),
    CONSTRAINT mentor_food_rules_source_check CHECK (source IN ('user', 'pattern', 'coach')),
    CONSTRAINT mentor_food_rules_label_check CHECK (char_length(label) <= 120)
);

-- One rule per food per user: a second statement about the same subject updates
-- the existing row rather than stacking a contradiction beside it.
CREATE UNIQUE INDEX idx_mentor_food_rules_user_subject ON mentor_food_rules (user_id, subject);
CREATE INDEX idx_mentor_food_rules_user_confirmed ON mentor_food_rules (user_id) WHERE confirmed_at IS NOT NULL;

-- A diet pattern is a preset that expands into rules on write, so enforcement
-- reads one place instead of special-casing vegetarian in every gate.
ALTER TABLE mentor_profiles ADD COLUMN IF NOT EXISTS diet_pattern TEXT NOT NULL DEFAULT '';
ALTER TABLE mentor_profiles ADD CONSTRAINT mentor_profiles_diet_pattern_check
    CHECK (diet_pattern IN ('', 'vegetarian', 'vegan', 'eggetarian', 'jain', 'halal', 'pescatarian'));

-- Derived containment facts, e.g. {contains-dairy,contains-gluten}. Backfilled
-- by cmd/dietag and maintained by ingest.
ALTER TABLE food_items ADD COLUMN IF NOT EXISTS diet_tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_food_items_diet_tags ON food_items USING gin (diet_tags);
