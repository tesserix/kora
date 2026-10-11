SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- NULL means unmeasured; a measured zero is stored as 0.
ALTER TABLE food_items
 ADD COLUMN sugar_per_100g DOUBLE PRECISION CHECK (sugar_per_100g >= 0),
 ADD COLUMN sat_fat_per_100g DOUBLE PRECISION CHECK (sat_fat_per_100g >= 0),
 ADD COLUMN sodium_mg_per_100g DOUBLE PRECISION CHECK (sodium_mg_per_100g >= 0),
 ADD COLUMN cholesterol_mg_per_100g DOUBLE PRECISION CHECK (cholesterol_mg_per_100g >= 0),
 ADD COLUMN calcium_mg_per_100g DOUBLE PRECISION CHECK (calcium_mg_per_100g >= 0),
 ADD COLUMN iron_mg_per_100g DOUBLE PRECISION CHECK (iron_mg_per_100g >= 0),
 ADD COLUMN potassium_mg_per_100g DOUBLE PRECISION CHECK (potassium_mg_per_100g >= 0),
 ADD COLUMN vitamin_a_ug_per_100g DOUBLE PRECISION CHECK (vitamin_a_ug_per_100g >= 0),
 ADD COLUMN vitamin_c_mg_per_100g DOUBLE PRECISION CHECK (vitamin_c_mg_per_100g >= 0),
 ADD COLUMN vitamin_d_ug_per_100g DOUBLE PRECISION CHECK (vitamin_d_ug_per_100g >= 0);
