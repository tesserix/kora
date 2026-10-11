CREATE TABLE mentor_commitment_proposals (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_turn_id UUID NOT NULL UNIQUE REFERENCES coach_turns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    cadence TEXT NOT NULL,
    weekdays_mask SMALLINT NOT NULL,
    start_minute SMALLINT NOT NULL,
    interval_minutes SMALLINT,
    end_minute SMALLINT,
    timezone TEXT NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE,
    source TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    accepted_commitment_id UUID UNIQUE REFERENCES mentor_commitments(id) ON DELETE SET NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mentor_proposals_title_check CHECK (char_length(title) BETWEEN 1 AND 120),
    CONSTRAINT mentor_proposals_kind_check CHECK (kind IN ('hydration', 'walking', 'meal', 'custom')),
    CONSTRAINT mentor_proposals_cadence_check CHECK (cadence IN ('fixed', 'interval')),
    CONSTRAINT mentor_proposals_weekdays_check CHECK (weekdays_mask BETWEEN 1 AND 127),
    CONSTRAINT mentor_proposals_start_check CHECK (start_minute BETWEEN 0 AND 1439),
    CONSTRAINT mentor_proposals_end_check CHECK (end_minute IS NULL OR end_minute BETWEEN 0 AND 1439),
    CONSTRAINT mentor_proposals_schedule_check CHECK (
        (cadence = 'fixed' AND interval_minutes IS NULL AND end_minute IS NULL)
        OR
        (cadence = 'interval' AND interval_minutes BETWEEN 30 AND 720 AND end_minute > start_minute)
    ),
    CONSTRAINT mentor_proposals_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT mentor_proposals_source_check CHECK (source IN ('coach', 'nutritionist', 'meal_planner')),
    CONSTRAINT mentor_proposals_timezone_check CHECK (char_length(timezone) BETWEEN 1 AND 64),
    CONSTRAINT mentor_proposals_agent_check CHECK (char_length(agent_name) BETWEEN 1 AND 120),
    CONSTRAINT mentor_proposals_reviewer_check CHECK (char_length(reviewed_by) BETWEEN 1 AND 120),
    CONSTRAINT mentor_proposals_acceptance_check CHECK (
        accepted_commitment_id IS NULL OR accepted_at IS NOT NULL
    )
);

CREATE INDEX mentor_commitment_proposals_user_created_idx
    ON mentor_commitment_proposals (user_id, created_at DESC, id);
