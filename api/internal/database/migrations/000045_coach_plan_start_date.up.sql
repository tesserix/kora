ALTER TABLE coach_plan_proposals
    ADD COLUMN starts_on DATE,
    ADD COLUMN timezone TEXT NOT NULL DEFAULT '';

UPDATE coach_plan_proposals AS plan
SET starts_on = (plan.accepted_at AT TIME ZONE COALESCE(NULLIF(users.timezone, ''), 'UTC'))::date,
    timezone = COALESCE(NULLIF(users.timezone, ''), 'UTC')
FROM users
WHERE users.id = plan.user_id
  AND plan.accepted_at IS NOT NULL;

-- The start date is written with the zone it was read in, so a stored date
-- can always be interpreted. Approval and both activation fields are one
-- state transition; a partial row is never valid.
ALTER TABLE coach_plan_proposals
    ADD CONSTRAINT coach_plan_proposals_start_zone_check CHECK (
        (accepted_at IS NULL AND starts_on IS NULL AND timezone = '') OR
        (accepted_at IS NOT NULL AND starts_on IS NOT NULL AND char_length(timezone) BETWEEN 1 AND 64)
    );
