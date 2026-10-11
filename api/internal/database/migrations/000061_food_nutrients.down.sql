SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE food_items
 DROP COLUMN sugar_per_100g,
 DROP COLUMN saturated_fat_per_100g,
 DROP COLUMN cholesterol_mg_per_100g,
 DROP COLUMN sodium_mg_per_100g,
 DROP COLUMN calcium_mg_per_100g,
 DROP COLUMN iron_mg_per_100g,
 DROP COLUMN potassium_mg_per_100g,
 DROP COLUMN magnesium_mg_per_100g,
 DROP COLUMN phosphorus_mg_per_100g,
 DROP COLUMN zinc_mg_per_100g,
 DROP COLUMN selenium_ug_per_100g,
 DROP COLUMN iodine_ug_per_100g,
 DROP COLUMN vitamin_a_rae_ug_per_100g,
 DROP COLUMN vitamin_a_re_ug_per_100g,
 DROP COLUMN vitamin_c_mg_per_100g,
 DROP COLUMN vitamin_d_ug_per_100g,
 DROP COLUMN vitamin_d_equivalents_ug_per_100g,
 DROP COLUMN vitamin_e_mg_per_100g,
 DROP COLUMN vitamin_k_ug_per_100g,
 DROP COLUMN thiamin_mg_per_100g,
 DROP COLUMN riboflavin_mg_per_100g,
 DROP COLUMN niacin_mg_per_100g,
 DROP COLUMN vitamin_b6_mg_per_100g,
 DROP COLUMN vitamin_b12_ug_per_100g,
 DROP COLUMN folate_ug_per_100g,
 DROP COLUMN folate_dfe_ug_per_100g;

