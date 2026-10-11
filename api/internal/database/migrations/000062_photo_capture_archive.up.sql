SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE photo_captures (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 object_key text NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK (length(sha256) = 64),
 content_type text NOT NULL CHECK (content_type = 'image/jpeg'),
 byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
 width integer NOT NULL CHECK (width > 0),
 height integer NOT NULL CHECK (height > 0),
 normalization_version integer NOT NULL DEFAULT 1,
 storage_status text NOT NULL CHECK (storage_status IN ('pending','stored','failed')),
 analysis_status text NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','completed','failed','canceled')),
 analysis jsonb,
 trace_id text NOT NULL DEFAULT '',
 archive_after timestamptz NOT NULL DEFAULT now() + interval '90 days',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_captures_user_created ON photo_captures(user_id,created_at DESC);
CREATE INDEX photo_captures_pending ON photo_captures(created_at) WHERE analysis_status = 'pending';

CREATE TABLE photo_object_deletions (
 object_key text PRIMARY KEY,
 not_before timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_object_deletions_due ON photo_object_deletions(not_before);
CREATE FUNCTION enqueue_photo_object_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO photo_object_deletions(object_key) VALUES (OLD.object_key) ON CONFLICT DO NOTHING;
 RETURN OLD;
END;
$$;
CREATE TRIGGER photo_capture_delete BEFORE DELETE ON photo_captures
 FOR EACH ROW EXECUTE FUNCTION enqueue_photo_object_deletion();
