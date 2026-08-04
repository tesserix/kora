-- Run against BOTH kora_db on global-postgres (before) and kora_db on
-- kora-postgres (after). Every row of output must be identical.
--
--   kubectl exec -n global global-postgres-1 -- psql -q -d kora_db -f - < this
--   kubectl exec -n kora   kora-postgres-1   -- psql -q -d kora_db -f - < this
--
-- /health returning 200 proves the API started. It proves nothing about the
-- data. These are the checks that do.
SET statement_timeout = '60s';

-- 1. Row counts for every table, not a sample.
SELECT relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY relname;

-- 2. The food index, and how much of it is actually embedded. A partially
--    restored index is the documented way every capture fails while the
--    service looks healthy.
SELECT count(*) AS food_items,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
       count(*) FILTER (WHERE embedding IS NULL)     AS not_embedded
FROM food_items;

-- 3. The HNSW index must exist. A restore that silently drops it leaves
--    resolution SLOW rather than broken — the hardest regression to notice.
SELECT indexname
FROM pg_indexes
WHERE tablename = 'food_items'
ORDER BY indexname;

-- 4. Extensions.
SELECT extname FROM pg_extension ORDER BY extname;

-- 5. Schema version, so a half-applied migration is visible.
SELECT * FROM schema_migrations;
