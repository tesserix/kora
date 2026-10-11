ALTER TABLE coach_plan_proposals
    DROP CONSTRAINT coach_plan_proposals_days_check;

ALTER TABLE coach_plan_proposals
    ADD CONSTRAINT coach_plan_proposals_days_check CHECK (
        jsonb_typeof(days) = 'array' AND jsonb_array_length(days) BETWEEN 1 AND 14
    );
