DROP TABLE weight_entries;
DROP TABLE water_entries;
DROP TABLE food_logs;
DROP TABLE food_aliases;
DROP TABLE food_items;

ALTER TABLE users
    DROP COLUMN sex,
    DROP COLUMN birth_year,
    DROP COLUMN height_cm,
    DROP COLUMN weight_kg,
    DROP COLUMN activity_level,
    DROP COLUMN goal,
    DROP COLUMN target_kcal,
    DROP COLUMN target_protein_g,
    DROP COLUMN target_carbs_g,
    DROP COLUMN target_fat_g,
    DROP COLUMN onboarded_at;
