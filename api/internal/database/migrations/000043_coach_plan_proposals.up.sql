CREATE TABLE coach_plan_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coach_turn_id UUID NOT NULL UNIQUE REFERENCES coach_turns(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    days JSONB NOT NULL,
    agent_name TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT coach_plan_proposals_summary_check CHECK (char_length(summary) <= 600),
    CONSTRAINT coach_plan_proposals_agent_check CHECK (char_length(agent_name) BETWEEN 1 AND 120),
    CONSTRAINT coach_plan_proposals_reviewer_check CHECK (char_length(reviewed_by) BETWEEN 1 AND 120),
    -- The card renders days as an array; a plan with no days has nothing to approve.
    CONSTRAINT coach_plan_proposals_days_check CHECK (
        jsonb_typeof(days) = 'array' AND jsonb_array_length(days) BETWEEN 1 AND 14
    )
);

CREATE INDEX coach_plan_proposals_user_created_idx
    ON coach_plan_proposals (user_id, created_at DESC, id);
