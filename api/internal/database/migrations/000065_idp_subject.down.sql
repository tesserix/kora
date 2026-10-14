ALTER TABLE users RENAME CONSTRAINT users_idp_subject_key TO users_firebase_uid_key;
ALTER TABLE users RENAME COLUMN idp_subject TO firebase_uid;
