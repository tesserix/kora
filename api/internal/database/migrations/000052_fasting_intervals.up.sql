-- Declared fasting intervals (kora#407). Kora previously inferred fasting from
-- an ABSENCE of food logs, which cannot tell "not eating" from "not logging" —
-- see kora#408 for the production bug that caused. A declared fast is a fact.
--
-- ended_at/ended_by are set ONLY by an explicit end. The other two ways a fast
-- ends -- the next food log, and the 48h cap -- are resolved at READ time and
-- never stored, so there is no write path to forget to hook and no job to run.
CREATE TABLE fasting_intervals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at   TIMESTAMPTZ,
    ended_by   TEXT,
    local_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fasting_intervals_ends_after_start
        CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT fasting_intervals_ended_by_check
        CHECK (ended_by IS NULL OR ended_by = 'user'),
    CONSTRAINT fasting_intervals_local_date_plausible
        CHECK (local_date > '2000-01-01'::date)
);

-- At most one OPEN fast per user. PARTIAL on purpose: a plain unique index on
-- (user_id) would also reject a second CLOSED fast, so nobody could ever fast
-- twice. ON CONFLICT against this index needs clause.TargetWhere with the
-- predicate matching verbatim, or Postgres errors 42P10.
CREATE UNIQUE INDEX fasting_intervals_one_open
    ON fasting_intervals (user_id) WHERE ended_at IS NULL;

CREATE INDEX idx_fasting_intervals_user_started
    ON fasting_intervals (user_id, started_at);
