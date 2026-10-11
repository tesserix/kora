SET lock_timeout = '5s';
SET statement_timeout = '30s';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM photo_captures) OR EXISTS (SELECT 1 FROM photo_object_deletions) THEN
  RAISE EXCEPTION 'Remove archived objects and drain deletion jobs before dropping the photo archive';
 END IF;
END $$;
DROP TABLE photo_captures;
DROP FUNCTION enqueue_photo_object_deletion();
DROP TABLE photo_object_deletions;
