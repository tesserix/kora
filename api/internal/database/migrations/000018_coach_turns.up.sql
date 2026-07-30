CREATE TABLE coach_turns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- seq is the only sound ordering key. Via GORM the two turns' created_at
    -- values differ by roughly 1ms (client-side clock reads, not a shared
    -- transaction timestamp). Client-side clock readings are not guaranteed
    -- strictly increasing (NTP steps, clock resolution), so seq — which the
    -- database assigns atomically at insert time — gives replay a stable
    -- ordering. Gaps from rollbacks are fine — only relative order matters.
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
