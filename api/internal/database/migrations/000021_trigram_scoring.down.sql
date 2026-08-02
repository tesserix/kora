-- Guarded: another object may depend on pg_trgm by the time this rolls back.
DROP EXTENSION IF EXISTS pg_trgm;
