-- Handles and profile pictures (kora#449). Supersedes #153's address-book
-- matching: Kora collects no phone numbers, and email-only matching is blind to
-- Apple relay addresses and makes people findable without a deliberate act.
--
-- A handle is exact-match only. There is no prefix search, no listing and no
-- directory anywhere in the API -- being findable in a weight app is
-- health-adjacent information, and a searchable directory would tell anyone who
-- cares who uses Kora.
ALTER TABLE users
    ADD COLUMN handle           TEXT,
    ADD COLUMN handle_canonical TEXT,
    ADD COLUMN avatar_path      TEXT;

-- PARTIAL, on the canonical form. Partial because most users have no handle and
-- NULLs must not collide. On the canonical form because `ada_l` and `ada_1` are
-- indistinguishable when spoken, and the failure that prevents is not a missed
-- lookup -- it is sending a friend request to a stranger and then sharing body
-- metrics with them.
CREATE UNIQUE INDEX users_handle_canonical_key
    ON users (handle_canonical) WHERE handle_canonical IS NOT NULL;

-- Changing your handle retires the old one PERMANENTLY. Otherwise anyone who
-- wrote down @ada sends requests to whoever claims it next.
--
-- No foreign key to users, and no ON DELETE CASCADE, deliberately: retirement
-- must outlive the account that held it, or deleting an account would return
-- its handle to the pool and reopen the same impersonation.
CREATE TABLE retired_handles (
    handle_canonical TEXT PRIMARY KEY,
    retired_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- avatar_path stores an OBJECT PATH, never a full URL: the bucket and CDN host
-- are deployment concerns, and baking today's infrastructure into user rows
-- means a bucket move rewrites the users table. The API composes the URL on read.
COMMENT ON COLUMN users.avatar_path IS
    'Object path (avatars/{user_id}/{version}.jpg), not a URL. The API composes the URL on read.';
