-- Plan page: a user may pin their own calorie/protein target. NULL means "use the
-- computed one". plan_basis_weight_kg is the weight the saved plan was computed
-- from, so the app can tell when a newer weigh-in makes it stale.
ALTER TABLE users
    ADD COLUMN target_kcal_override DOUBLE PRECISION,
    ADD COLUMN target_protein_override_g DOUBLE PRECISION,
    ADD COLUMN plan_basis_weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN plan_saved_at TIMESTAMPTZ;

UPDATE users SET plan_basis_weight_kg = weight_kg;
