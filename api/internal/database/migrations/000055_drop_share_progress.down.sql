ALTER TABLE users ADD COLUMN share_progress BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET share_progress = true
WHERE id IN (
    SELECT c.owner_id FROM share_circles c
    JOIN share_grants g ON g.circle_id = c.id AND g.category = 'progress'
);
