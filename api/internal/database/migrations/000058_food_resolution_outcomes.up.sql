-- Every resolve attempt's outcome, so "did the resolver work" stops being a
-- feeling (kora#459).
--
-- Nothing recorded a resolution outcome before this. The resolver already drew
-- the distinctions that matter — internal/ai/resolver.go logs "returning
-- low-confidence match", "abstaining — best match below the floor" and "no
-- match and nothing to decompose" as three separate lines, precisely because
-- they demand opposite responses (lower the floor vs add index data) — but a
-- log line cannot be counted, queried or triaged. This table is those lines,
-- kept.
--
-- It is a per-attempt row, not a per-failure row. Recording only failures
-- would make the failure COUNT available and the failure RATE uncomputable:
-- the denominator is attempts, and a resolve that succeeds leaves no other
-- trace (a cache hit does not even reach the provider, so ai_usage_events
-- cannot supply it either). kora#328's "resolution correct on first try for
-- >=90% of logs" needs both halves.
CREATE TABLE food_resolution_outcomes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- ON DELETE CASCADE, like every other user-scoped table: an account
    -- deletion must take these with it. They carry the user's own words.
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- kind is WHICH BRANCH of the resolver terminated the attempt. The values
    -- mirror the code's own branches rather than a taxonomy invented here, so
    -- a reader can go from a row to the line that produced it:
    --
    --   cache        Cache.Get hit -- no provider call, no index lookup.
    --   alias        Personal-alias short-circuit: a PREVIOUS correction paying
    --                off. Counting these as plain successes would hide the
    --                single clearest evidence that corrections work.
    --   resolved     Matched at auto or confirm tier.
    --   weak_match   Low-confidence match returned rather than decomposed (#180).
    --   below_floor  Candidates existed, all under minReturnableMatchScore --
    --                the index HAS near-misses. Fixed by lowering the floor.
    --   no_match     No candidate and nothing to decompose -- an index GAP.
    --                Fixed only by adding data. Distinct from below_floor on
    --                purpose; conflating them sends someone to the wrong fix.
    --   decomposed   Estimated by summing ingredients. The estimate is unscaled
    --                and can be an order of magnitude high (see resolver.go).
    --   budget       The user's AI budget was exhausted before any call.
    --   error        The provider call failed.
    --   transcript_blank  A voice capture transcribed to nothing. A CAPTURE
    --                failure -- not an index gap, not a provider fault --
    --                so it gets its own kind rather than being folded into
    --                one of those and driving the wrong fix.
    kind       TEXT NOT NULL,

    -- The resolver's OWN Tier (auto/confirm/follow_up), never a threshold
    -- re-derived here. ai.TierFor owns that decision and this column must not
    -- become a second opinion about it. Empty where no tier was reached
    -- (cache, budget, error).
    tier       TEXT NOT NULL DEFAULT '',

    -- text | photo | voice | barcode. How the user asked.
    mode       TEXT NOT NULL,

    -- What the user actually said. NULL for a photo, which has no phrase.
    --
    -- This is the same category of data food_logs.input_phrase already holds,
    -- so it introduces no new privacy surface -- and it is the whole point:
    -- without the phrase, a failure row says something failed and nothing
    -- about what to fix.
    phrase     TEXT,

    -- The best candidate the index offered, and how well it scored. NULL when
    -- there were none. top_food_item_id is ON DELETE SET NULL rather than
    -- CASCADE: retiring a food must not erase the evidence that it was the
    -- near-miss for a phrase.
    top_food_item_id UUID REFERENCES food_items(id) ON DELETE SET NULL,
    top_score        DOUBLE PRECISION,
    candidate_count  INTEGER NOT NULL DEFAULT 0,

    -- Triage lifecycle, mirroring feedback.status so the console's inbox can
    -- treat both queues identically (#432). Only below_floor and no_match are
    -- ever surfaced for triage; the rest are measurement.
    status     TEXT NOT NULL DEFAULT 'open',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Closed sets, enforced. A typo'd kind would be invisible in every aggregate
-- below and silently wrong in the inbox, which is the failure this whole table
-- exists to stop happening to resolution itself.
ALTER TABLE food_resolution_outcomes ADD CONSTRAINT food_resolution_outcomes_kind_chk
    CHECK (kind IN ('cache','alias','resolved','weak_match','below_floor',
                    'no_match','decomposed','budget','error','transcript_blank'));
ALTER TABLE food_resolution_outcomes ADD CONSTRAINT food_resolution_outcomes_mode_chk
    CHECK (mode IN ('text','photo','voice','barcode'));
ALTER TABLE food_resolution_outcomes ADD CONSTRAINT food_resolution_outcomes_status_chk
    CHECK (status IN ('open','in_progress','resolved','closed'));
ALTER TABLE food_resolution_outcomes ADD CONSTRAINT food_resolution_outcomes_tier_chk
    CHECK (tier IN ('','auto','confirm','follow_up'));

-- Serves the inbox: open items needing a human, oldest first.
CREATE INDEX ix_fro_triage ON food_resolution_outcomes (status, created_at)
    WHERE kind IN ('below_floor','no_match');

-- Intended to serve the rate and the per-kind rollups. It does NOT: the rate
-- query range-filters created_at and groups by kind, so a kind-leading index
-- offers no seek. Replaced by ix_fro_created_kind in 000059 (#517). Left here
-- as written so the migration history stays truthful.
CREATE INDEX ix_fro_kind_created ON food_resolution_outcomes (kind, created_at);

-- Serves the export's user scoping and the cascade.
CREATE INDEX ix_fro_user_created ON food_resolution_outcomes (user_id, created_at);
