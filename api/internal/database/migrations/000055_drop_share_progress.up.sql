-- Backfill circles from the boolean this replaces (kora#326), then drop it.
--
-- share_progress = true meant "every accepted friend may see my progress", so
-- the equivalent circle is one named "Friends" holding exactly those friends,
-- granted `progress`. false meant nothing was shared and writes no rows -- the
-- new default is deny, same as the old one.
--
-- This is cheap because Kora is PRE-LAUNCH with one real account. Against a
-- live user base, silently reconstructing everyone's sharing from a boolean
-- would deserve materially more care than this.
--
-- The first INSERT has no ON CONFLICT guard, unlike the two below it: it is
-- the only one of the three that can violate a unique constraint (a user who
-- already owns a circle named "Friends" while share_progress = true aborts
-- the whole migration instead of silently merging into it). The members and
-- grants INSERTs, by contrast, are idempotent no-ops on a second run. Do not
-- read that as "these three statements are equally safe to re-run" -- they
-- are not.
INSERT INTO share_circles (id, owner_id, name)
SELECT gen_random_uuid(), u.id, 'Friends'
FROM users u
WHERE u.share_progress = true;

-- Scoped to c.name = 'Friends' AND u.share_progress = true (not name alone):
-- Task 6 lets any user create their own circle named "Friends" before this
-- migration ever runs. Matching on the name alone would silently add that
-- user's accepted friends and a `progress` grant to THEIR circle even though
-- share_progress was false for them -- widening a stranger's sharing with no
-- error and no log line. Joining back to users.share_progress = true (still
-- present here; the DROP is the last statement) restricts both INSERTs to
-- exactly the circles the first INSERT just created.
INSERT INTO share_circle_members (circle_id, member_user_id)
SELECT c.id,
       CASE WHEN f.requester_id = c.owner_id THEN f.addressee_id ELSE f.requester_id END
FROM share_circles c
JOIN users u ON u.id = c.owner_id AND u.share_progress = true
JOIN friendships f
  ON (f.requester_id = c.owner_id OR f.addressee_id = c.owner_id)
 AND f.status = 'accepted'
WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

INSERT INTO share_grants (circle_id, category)
SELECT c.id, 'progress'
FROM share_circles c
JOIN users u ON u.id = c.owner_id AND u.share_progress = true
WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

ALTER TABLE users DROP COLUMN share_progress;
