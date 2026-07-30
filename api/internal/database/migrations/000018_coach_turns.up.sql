CREATE TABLE coach_turns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- seq exists because a question and its answer are written in the same
    -- transaction, and Postgres now() returns the transaction-start time for
    -- both rows, so created_at alone cannot order them. seq is assigned at
    -- insert time and is strictly increasing regardless of transaction
    -- timing, giving replay a stable oldest-first order. Gaps from rollbacks
    -- are fine — only relative order matters.
    seq        BIGSERIAL NOT NULL
);
CREATE INDEX ix_coach_turns_user_seq ON coach_turns (user_id, seq);

CREATE TABLE coach_turn_citations (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id  UUID NOT NULL REFERENCES coach_turns(id) ON DELETE CASCADE,
    label    TEXT NOT NULL,
    value    TEXT NOT NULL,
    position INT NOT NULL,
    UNIQUE (turn_id, position)
);
