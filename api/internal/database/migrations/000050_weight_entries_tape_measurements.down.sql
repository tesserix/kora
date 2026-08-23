-- Reverses 000050_weight_entries_tape_measurements.up.sql (kora#45).
ALTER TABLE weight_entries
    DROP COLUMN IF EXISTS neck_cm,
    DROP COLUMN IF EXISTS chest_cm,
    DROP COLUMN IF EXISTS waist_cm,
    DROP COLUMN IF EXISTS hip_cm,
    DROP COLUMN IF EXISTS arm_cm,
    DROP COLUMN IF EXISTS thigh_cm;
