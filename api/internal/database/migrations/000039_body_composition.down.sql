-- Reverses 000039_body_composition.up.sql (kora#45).
--
-- `body_fat_pct` is NOT dropped here: it predates this migration, having been
-- created by 000002_phase1_core, and dropping it would destroy a column this
-- migration only exposed rather than added.
ALTER TABLE weight_entries DROP CONSTRAINT IF EXISTS weight_entries_source_check;

ALTER TABLE weight_entries
    DROP COLUMN IF EXISTS subcutaneous_fat_pct,
    DROP COLUMN IF EXISTS visceral_fat_rating,
    DROP COLUMN IF EXISTS skeletal_muscle_pct,
    DROP COLUMN IF EXISTS muscle_mass_kg,
    DROP COLUMN IF EXISTS body_water_pct,
    DROP COLUMN IF EXISTS protein_pct,
    DROP COLUMN IF EXISTS bone_mass_kg,
    DROP COLUMN IF EXISTS scale_bmr_kcal,
    DROP COLUMN IF EXISTS source;
