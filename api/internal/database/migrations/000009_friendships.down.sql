DROP INDEX IF EXISTS ux_users_friend_code;
ALTER TABLE users DROP COLUMN IF EXISTS friend_code;
DROP TABLE IF EXISTS friendships;
