-- Minimal fixture for the admin-conformance CI step (kora#519).
--
-- CI's Postgres is a fresh, empty container, so the entity row-shape checks
-- (§8.9) and the "empty array" check (§4.5) had nothing to exercise and
-- SILENTLY SKIPPED instead of passing. This file gives the conformance
-- suite exactly one row per entity type it inspects -- enough to make those
-- checks real, not a copy of production-shaped data.
--
-- Applied directly with psql/`go run ./cmd/migrate`'s target database in the
-- CI workflow, after migrations and before the conformance CLI starts. Not
-- wired into cmd/seed: that seeds ~50 curated food items for local dev and
-- has no notion of users at all, which is both more than this needs and
-- missing the half it needs most.
--
-- Obviously fake: the email domain does not resolve, and the id and firebase
-- uid are pinned so a re-run is idempotent (ON CONFLICT DO NOTHING) rather
-- than accumulating rows on every CI job.

-- One user with a HANDLE, so §8.9's sublabel rule -- handle when present,
-- email otherwise -- is exercised on the branch that actually distinguishes
-- two people, not the fallback.
INSERT INTO users (id, firebase_uid, email, display_name, handle, handle_canonical)
VALUES (
    '00000000-0000-0000-0000-0000000005f9',
    'ci-conformance-fixture-user-519',
    'ci-conformance-fixture@example.invalid',
    'CI Conformance Fixture',
    'ci_conformance_fixture',
    'ci_conformance_fixture'
)
ON CONFLICT (id) DO NOTHING;

-- One food item, so the `entities/foods` row shape is exercised too.
INSERT INTO food_items (id, name, brand, provenance, kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g)
VALUES (
    '00000000-0000-0000-0000-0000000005fa',
    'CI Conformance Fixture Food',
    'Fixture Brand',
    'curated',
    100, 1, 1, 1
)
ON CONFLICT (id) DO NOTHING;
