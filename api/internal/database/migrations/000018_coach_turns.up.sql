CREATE TABLE coach_turns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_coach_turns_user_created ON coach_turns (user_id, created_at);

CREATE TABLE coach_turn_citations (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id  UUID NOT NULL REFERENCES coach_turns(id) ON DELETE CASCADE,
    label    TEXT NOT NULL,
    value    TEXT NOT NULL,
    position INT NOT NULL
);
CREATE INDEX ix_coach_turn_citations_turn ON coach_turn_citations (turn_id);
