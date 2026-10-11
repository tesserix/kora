-- WARNING (kora#326 whole-branch review, F5): this rollback WIDENS sharing,
-- it does not restore the pre-migration state.
--
-- 1. share_progress was a single global boolean that exposed "progress" to
--    EVERY accepted friend at once. The UP migration replaced it with
--    per-circle grants, so an owner can share "progress" with a two-person
--    circle without exposing it to friends outside that circle. The
--    backfill below cannot recover that distinction -- it sets
--    share_progress = true for ANY owner holding so much as one
--    circle-scoped "progress" grant, which means a rollback re-exposes that
--    owner's progress to every friend they have, not just the circle they
--    chose. Do not run this down migration expecting to undo an exposure;
--    it can only create a wider one.
--
-- 2. This migration alone does not make `migrate down` twice then `migrate
--    up` clean: 000055's up migration (the DROP COLUMN) is preceded by
--    000054, which created share_circles/share_circle_members/share_grants
--    and backfilled them from share_progress. Stepping down only 000055
--    leaves those backfilled circles in place, so re-running 000054's up
--    migration is not needed, but re-running THIS migration's up (DROP
--    COLUMN share_progress) after a fresh 000054 backfill will violate
--    share_circles_owner_name (the backfilled circle name collides with
--    itself) on a second pass. A clean re-run requires also stepping 000054
--    down first, then back up through both.
--
-- This is accepted as-is, not re-engineered, because Kora is pre-launch
-- with a single test account: there is no real user data at stake, and
-- building a lossless per-circle-to-global downgrade path for a migration
-- that will likely never be rolled back in production is not worth the
-- complexity. If this migration is ever run down against real user data,
-- treat it as a privacy incident, not a routine rollback.
ALTER TABLE users ADD COLUMN share_progress BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET share_progress = true
WHERE id IN (
    SELECT c.owner_id FROM share_circles c
    JOIN share_grants g ON g.circle_id = c.id AND g.category = 'progress'
);
