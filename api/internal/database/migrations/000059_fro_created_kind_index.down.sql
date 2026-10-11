-- Restore #459's original index. See the up migration for why the column
-- order was wrong for the query it was written to serve.
DROP INDEX IF EXISTS ix_fro_created_kind;

CREATE INDEX ix_fro_kind_created ON food_resolution_outcomes (kind, created_at);
