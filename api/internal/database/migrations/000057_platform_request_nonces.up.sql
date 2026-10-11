-- Replay defence for the platform console's signed /v1/admin/* calls
-- (package platformauth). Every federated request carries a single-use
-- nonce; this table is what makes "single-use" true across replicas.
--
-- It is deliberately a TABLE and not an in-process set. kora-api runs more
-- than one pod, so an in-memory claim would let a captured request replay
-- simply by landing on a different one — a defence that works only at one
-- replica is not a defence, and nothing about it would look broken.
--
-- Distinct from bffauth's protection, which has none: that scheme carries no
-- nonce and relies on its 60s window alone. This surface is the one the
-- platform console reaches, so it gets the stronger of the two.
CREATE TABLE IF NOT EXISTS platform_request_nonces (
    nonce      UUID PRIMARY KEY,
    seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Serves the sweep's `expires_at < now()` scan. Without it the sweep is a
-- sequential scan over a table that only ever grows.
CREATE INDEX IF NOT EXISTS idx_platform_request_nonces_expires_at
    ON platform_request_nonces (expires_at);
