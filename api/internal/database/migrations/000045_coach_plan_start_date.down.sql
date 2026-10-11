ALTER TABLE coach_plan_proposals
    DROP CONSTRAINT coach_plan_proposals_start_zone_check;

ALTER TABLE coach_plan_proposals
    DROP COLUMN starts_on,
    DROP COLUMN timezone;
