-- Kora's identities now come from Zitadel. The column holds the token's `sub`,
-- whichever provider issued it, so it no longer carries a provider's name.
-- Firebase-era rows are wiped before cutover, so no value is translated.
ALTER TABLE users RENAME COLUMN firebase_uid TO idp_subject;
ALTER TABLE users RENAME CONSTRAINT users_firebase_uid_key TO users_idp_subject_key;
