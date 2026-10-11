SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE food_items
 DROP COLUMN sugar_per_100g,
 DROP COLUMN sat_fat_per_100g,
 DROP COLUMN sodium_mg_per_100g,
 DROP COLUMN cholesterol_mg_per_100g,
 DROP COLUMN calcium_mg_per_100g,
 DROP COLUMN iron_mg_per_100g,
 DROP COLUMN potassium_mg_per_100g,
 DROP COLUMN vitamin_a_ug_per_100g,
 DROP COLUMN vitamin_c_mg_per_100g,
 DROP COLUMN vitamin_d_ug_per_100g;
