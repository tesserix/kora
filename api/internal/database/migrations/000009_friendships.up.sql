CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (requester_id <> addressee_id)
);
CREATE UNIQUE INDEX ux_friendships_pair ON friendships (
    LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)
);
CREATE INDEX ix_friendships_addressee ON friendships (addressee_id);

ALTER TABLE users ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX ux_users_friend_code ON users (friend_code);
