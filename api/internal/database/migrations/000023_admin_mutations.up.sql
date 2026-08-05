-- Admin mutations (slice 2 of the food-data admin design).
--
-- deleted_at exists because a HARD delete is destructive in three ways the
-- food_logs FK does not show. Verified against the live schema:
--   food_aliases.food_item_id      ON DELETE CASCADE  -- destroys a user's taught
--                                                     -- corrections (issue #20)
--   pins.food_item_id              ON DELETE CASCADE
--   saved_meal_items.food_item_id  ON DELETE CASCADE  -- can gut a saved meal
--   food_logs.food_item_id         ON DELETE SET NULL -- log survives, orphaned
-- Every read path must therefore filter deleted_at IS NULL, including the
-- kora_food_index_* gauges, or retired rows silently keep being counted.
ALTER TABLE food_items ADD COLUMN deleted_at timestamptz NULL;
ALTER TABLE food_items ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill existing rows so a pre-existing food does not read as "just
-- edited" the instant this migration deployed. A later admin task renders a
-- last-edited column from updated_at; without this backfill it would report
-- every one of the ~7,900 production foods as edited at deploy time, and the
-- true information (nothing has touched these rows since they were written)
-- is unrecoverable once the DEFAULT now() has already stamped them.
UPDATE food_items SET updated_at = created_at;

-- idx_food_items_live (id) WHERE deleted_at IS NULL was measured against a
-- 7,902-row probe (40 retired) seeded to production shape and dropped:
--   - `WHERE id = ? AND deleted_at IS NULL` gets 4 buffer hits either way —
--     falling through to the PK with deleted_at as a heap recheck is free.
--   - the admin ILIKE search can't use it: its leading column is id, the
--     predicate is on name/brand.
--   - the completeness gauge's `count(*) WHERE deleted_at IS NULL` is only
--     served by it with enable_seqscan forced off; the planner prefers a
--     seqscan otherwise.
-- Net cost was ~320 kB plus write amplification on every insert and update
-- (including the updated_at touch above) for zero measured read benefit.
--
-- Round 1 made these five indexes partial on WHERE deleted_at IS NULL. That
-- was REVERTED in round 2: migrations run as a sync-wave-0 Kubernetes Job
-- BEFORE the new API image rolls out, so there is a guaranteed window in
-- which the running pods are still the OLD image, whose queries against
-- food_items carry no deleted_at predicate at all. A partial index's
-- predicate must be implied by the query for the planner to use it — during
-- that window it cannot be, and every hot read path silently loses its
-- index. Measured on a 7,902-row probe against the query shapes in
-- internal/nutrition/repository.go: the full-text tier went from 0.010 ms to
-- 8.79 ms (a sequential scan, ~880x), and the HNSW vector tier from 0.34 ms
-- to 19.8 ms (~58x). Resolve is the latency-sensitive path here and sits
-- under a 30s Istio perTryTimeout that has already caused an outage once.
--
-- The predicate a partial index depends on must exist in DEPLOYED code
-- before the index itself can depend on it, and migrations run ahead of the
-- rollout that would add it (a future task, not yet written). Until that
-- code ships and has been deployed, these five stay non-partial. Do not
-- re-apply the round-1 change without first confirming that ordering.
--
-- They are still dropped and recreated here, identically, only to keep this
-- migration's shape self-documenting about what round 1 touched; verified
-- byte-for-byte against pg_indexes.indexdef captured at v22 (pre-000023).
DROP INDEX idx_food_items_normalized_name;
CREATE INDEX idx_food_items_normalized_name ON food_items (normalized_name);

DROP INDEX idx_food_items_name_trgm;
CREATE INDEX idx_food_items_name_trgm ON food_items (lower(name));

DROP INDEX idx_food_items_name;
CREATE INDEX idx_food_items_name ON food_items USING gin (to_tsvector('simple', name));

DROP INDEX idx_food_items_normalized_name_fts;
CREATE INDEX idx_food_items_normalized_name_fts ON food_items USING gin (to_tsvector('simple', normalized_name));

DROP INDEX idx_food_items_embedding;
CREATE INDEX idx_food_items_embedding ON food_items USING hnsw (embedding vector_cosine_ops);

-- kora_admin_events is written INSIDE the transaction that performs the
-- mutation, so an audit row cannot go missing when the write succeeds.
-- actor_* come from the BFF-verified identity on the Gin context, never from
-- the request body.
--
-- actor_email carries a CHECK, not just NOT NULL: bffauth.Middleware rejects
-- an empty UserID but has no guard on Email, so a correctly-signed request
-- carrying X-User-Email: "" authenticates cleanly, and NOT NULL alone would
-- let the audit insert store an empty string — defeating the point of an
-- attribution table. The CHECK turns that gap into a 500 on insert instead
-- of a silently unattributed row. Round 2 also closed the gap in bffauth
-- itself (see bffauth.Middleware's 403 branch), which turns most of these
-- into a clean 403 at the edge — but the CHECK stays as a backstop for any
-- other write path into this table. btrim, not a bare <> '', so a
-- whitespace-only email ("   ") is rejected too, not just the empty string.
--
-- No FK from target_id to food_items(id): an audit row must outlive its
-- target, so a FK would either cascade the evidence away when the target is
-- deleted, or block the very deletion it exists to record.
CREATE TABLE kora_admin_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     text        NOT NULL,
    actor_email  text        NOT NULL CHECK (btrim(actor_email) <> ''),
    action       text        NOT NULL,
    target_type  text        NOT NULL,
    target_id    uuid        NULL,
    before       jsonb       NULL,
    after        jsonb       NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kora_admin_events_created ON kora_admin_events (created_at DESC);
-- Partial: most events are not scoped to a single food (e.g. AI-key
-- management actions), so target_id is NULL for them; indexing only the
-- rows that carry a target avoids indexing a column absent from most rows.
CREATE INDEX idx_kora_admin_events_target ON kora_admin_events (target_id, created_at DESC) WHERE target_id IS NOT NULL;
