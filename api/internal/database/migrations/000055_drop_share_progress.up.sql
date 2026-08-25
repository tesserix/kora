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
INSERT INTO share_circles (id, owner_id, name)
SELECT gen_random_uuid(), u.id, 'Friends'
FROM users u
WHERE u.share_progress = true;

INSERT INTO share_circle_members (circle_id, member_user_id)
SELECT c.id,
       CASE WHEN f.requester_id = c.owner_id THEN f.addressee_id ELSE f.requester_id END
FROM share_circles c
JOIN friendships f
  ON (f.requester_id = c.owner_id OR f.addressee_id = c.owner_id)
 AND f.status = 'accepted'
WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

INSERT INTO share_grants (circle_id, category)
SELECT c.id, 'progress' FROM share_circles c WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

ALTER TABLE users DROP COLUMN share_progress;
