DROP TABLE IF EXISTS retired_handles;
DROP INDEX IF EXISTS users_handle_canonical_key;
ALTER TABLE users
    DROP COLUMN IF EXISTS avatar_path,
    DROP COLUMN IF EXISTS handle_canonical,
    DROP COLUMN IF EXISTS handle;
