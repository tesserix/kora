CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE food_items
    ADD COLUMN embedding vector(768),
    ADD COLUMN normalized_name TEXT NOT NULL DEFAULT '';

-- Approximate backfill; precise Go-normalized values are set on write and by
-- `cmd/ingest -backfill-normalized` (Task 5).
UPDATE food_items SET normalized_name = lower(btrim(name));

CREATE INDEX idx_food_items_normalized_name ON food_items (normalized_name);
CREATE INDEX idx_food_items_embedding ON food_items
    USING hnsw (embedding vector_cosine_ops);
