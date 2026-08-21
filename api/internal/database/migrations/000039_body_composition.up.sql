-- kora#45. Body composition beyond a bare weight.
--
-- `weight_entries` already carried `body_fat_pct` since 000002_phase1_core, but
-- nothing ever read or wrote it: it was absent from the Go model and from the
-- client's WeightEntry type. This migration widens the row to the rest of what a
-- consumer smart scale actually reports, and #45's Go/TS changes finally expose
-- `body_fat_pct` alongside them.
--
-- The field set is taken from two real devices (Renpho and Omron), not from a
-- guess. Everything here is a MEASURED value; the derived ones are deliberately
-- absent — see the bottom of this file.

ALTER TABLE weight_entries
    ADD COLUMN subcutaneous_fat_pct DOUBLE PRECISION,
    -- NOT a percentage, and deliberately not named `_pct`. Renpho displays a
    -- bare `7`; Omron displays `7.5 level`; Tanita uses a 1-59 rating. It is a
    -- vendor rating on a vendor scale, so it is stored as DOUBLE (Omron's half
    -- steps rule out INT) and must never be rendered with a % sign. Reading it
    -- as a percent is the single most plausible mistake in this table.
    ADD COLUMN visceral_fat_rating DOUBLE PRECISION,
    -- Skeletal muscle is a SUBSET of total muscle mass. Renpho reports both, and
    -- conflating them is silently wrong, so they are two columns.
    ADD COLUMN skeletal_muscle_pct DOUBLE PRECISION,
    ADD COLUMN muscle_mass_kg DOUBLE PRECISION,
    ADD COLUMN body_water_pct DOUBLE PRECISION,
    ADD COLUMN protein_pct DOUBLE PRECISION,
    -- Bone MASS in kg, as a scale reports it. A DEXA report's bone DENSITY
    -- (BMD, T-score) is a different quantity and does not belong in this column.
    ADD COLUMN bone_mass_kg DOUBLE PRECISION,
    -- Recorded for comparison ONLY. It must never feed a calorie target.
    --
    -- Kora derives BMR itself via Mifflin-St Jeor (internal/onboarding/calc.go
    -- and its TS mirror apps/mobile/src/lib/plan.ts), and that derived value is
    -- what drives the user's daily kcal target and its floor. The two devices
    -- above disagree by ~200 kcal/day on the same body (Renpho 1627, Omron
    -- 1423), so letting a scale reading drive targets would make the target jump
    -- when the user changes scales. Named `scale_bmr_kcal` rather than
    -- `bmr_kcal` so that any code reaching for it reads as obviously wrong.
    ADD COLUMN scale_bmr_kcal DOUBLE PRECISION,
    -- Provenance is NOT metadata here: the same-named metric is not comparable
    -- across instruments. Measured off the two screenshots, Renpho reports
    -- Skeletal Muscle at 48.9% where Omron reports 25.7% — different definitions
    -- of the same words, not measurement noise. DEXA and consumer bioimpedance
    -- body fat differ by several points on the same body on the same day.
    --
    -- Without this column a chart joining readings from two scales would show a
    -- person losing half their muscle overnight, and it would look like data.
    -- A trend must therefore consult `source` before joining two points.
    ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Existing rows were all typed by hand, so the 'manual' default is accurate for
-- them rather than merely convenient.
ALTER TABLE weight_entries ADD CONSTRAINT weight_entries_source_check
    CHECK (source IN ('manual', 'scale_screenshot', 'inbody', 'dexa', 'healthkit'));

-- Deliberately NOT stored, each because it is derived or vendor opinion:
--
--   BMI              -- from height and weight, both of which Kora already owns
--                       (apps/mobile/src/lib/plan.ts). A read BMI would be a
--                       second source of truth able to contradict Kora's own
--                       height and weight.
--   fat-free mass    -- weight_kg minus fat mass. Omron prints it (58.21 kg);
--                       it is still arithmetic.
--   fat mass in kg   -- Omron reports body fat as BOTH 32.6 % and 22.9 kg: one
--                       fact in two units. The percentage is stored; kg is
--                       weight_kg * body_fat_pct / 100.
--   metabolic age    -- vendor-invented, no standard definition, not comparable
--                       between devices or over time.
--   qualitative bands -- "Average", "Low", "High", "Excellent". Vendor
--                       interpretation, not measurement. Kora should not inherit
--                       another company's judgement about a user's body.
--
-- Storing a derived value alongside its inputs lets one row contradict itself,
-- with nothing to tell a reader which field to believe. Store what was
-- measured; derive the rest (see apps/mobile/src/lib/bodyComposition.ts).
