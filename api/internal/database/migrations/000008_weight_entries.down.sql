-- Intentionally a no-op — see 000008_weight_entries.up.sql.
--
-- This previously ran `DROP TABLE IF EXISTS weight_entries`, which would have
-- destroyed a table owned by 000002_phase1_core. Rolling back to version 7 must
-- leave `weight_entries` intact; 000002's down-migration is what drops it.
SELECT 1;
