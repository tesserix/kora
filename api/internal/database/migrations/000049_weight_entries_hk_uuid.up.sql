-- kora#30. HealthKit weights arrive as ordinary weight_entries rows with
-- source 'healthkit', so they inherit R4's provenance and per-instrument
-- trend behaviour for free. What they need that a typed weigh-in does not is
-- a stable identity from the system they came from.
--
-- Foreground sync re-sends its whole window whenever a previous sync failed
-- (the device only advances its anchor on success), so the retry path IS the
-- normal path and the write has to be idempotent rather than merely careful.
ALTER TABLE weight_entries ADD COLUMN hk_uuid UUID;

-- PARTIAL, and that is the whole point: manual and screenshot weigh-ins carry
-- no HealthKit UUID. A plain unique index would constrain those NULL rows
-- together in any engine that treats NULLs as equal, capping a user at one
-- hand-typed weigh-in. Postgres does not, but the index says what is meant
-- rather than relying on that.
CREATE UNIQUE INDEX weight_entries_hk_uuid_key
    ON weight_entries (user_id, hk_uuid)
    WHERE hk_uuid IS NOT NULL;
