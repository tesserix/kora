-- kora#45. Tape measurements alongside the scale metrics.
--
-- These go on `weight_entries` rather than a table of their own, and weight
-- stays required. The accepted consequence: a tape measurement can only be
-- recorded as part of a weigh-in, and there is no tape-only entry. That keeps
-- one row per moment-in-time, so a chart never has to reconcile two timelines
-- of the same body.
--
-- All six are nullable because a tape is used piecemeal -- someone measuring
-- their waist has not also measured their neck -- and NULL must stay
-- distinguishable from a measured value, exactly as for the scale metrics
-- added in 000039.
--
-- Centimetres in the column name, not a unit column: storage is one unit and
-- the client converts for display (see apps/mobile). A `_cm` suffix makes a
-- value read in inches obviously wrong at the point of use.
ALTER TABLE weight_entries
    ADD COLUMN neck_cm DOUBLE PRECISION,
    ADD COLUMN chest_cm DOUBLE PRECISION,
    ADD COLUMN waist_cm DOUBLE PRECISION,
    ADD COLUMN hip_cm DOUBLE PRECISION,
    -- Singular: one arm and one thigh, whichever the user consistently
    -- measures. Left/right pairs would double the field count for a
    -- difference no consumer tape reliably resolves.
    ADD COLUMN arm_cm DOUBLE PRECISION,
    ADD COLUMN thigh_cm DOUBLE PRECISION;

-- Deliberately NOT stored:
--
--   waist-to-hip ratio -- derived from two columns above, and a stored ratio
--                         could contradict its own inputs. Derive it beside
--                         BMI in apps/mobile/src/lib/bodyComposition.ts if it
--                         is ever wanted.
--
-- Bounds are enforced in validateComposition (internal/tracking/repository.go)
-- rather than as CHECK constraints, so an impossible value reads as a 400
-- naming the field instead of a 500 from a constraint violation.
