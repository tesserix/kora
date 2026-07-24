# Phase 2b — Resolution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AI resolution engine — provider clients (Gemini primary, OpenAI fallback) behind an `ai.Provider` interface, a router with error/timeout fallback, a resolution service (identify → resolve against the 2a index → confidence tiers → ingredient decomposition → portion ranges), a Redis cache, and `AIUsageEvent` metering — enforcing the hard invariant that the LLM never emits a stored nutrition number. **Built with stubs**: every layer above the concrete SDK adapters is unit-tested with a stub `Provider`; live provider calls happen only in a keyed smoke and in Phase 2c.

**Architecture:** All SDK specifics live in two thin adapters (`ai/providers/gemini.go`, `ai/providers/openai.go`) that implement `ai.Provider`. The router, resolver, cache, and metering depend only on the interface, so they are deterministic and testable without keys. The resolver reuses `nutrition.Resolve` (2a) for index lookup and generates query embeddings via the provider's `Embed`; nutrition numbers come exclusively from `FoodItem` rows. A separate command backfills `food_items.embedding` via the embedder (real run needs keys; the column exists from 2a).

**Tech Stack:** Go 1.26; `google.golang.org/genai` (Gemini: vision, chat, `text-embedding-004`); `github.com/openai/openai-go` (GPT-5-mini fallback); `github.com/redis/go-redis/v9` (optional cache); GORM/Postgres; testify. Keys via env (`GEMINI_API_KEY`, `OPENAI_API_KEY`). No live calls in normal `go test`.

## Global Constraints

- **Hard invariant (enforced structurally + tested):** provider responses are parsed for **food identity + portion only**. Any numeric nutrition field in an LLM response is rejected at the parse boundary and never propagated. Every nutrition number in a `Resolution` comes from a `nutrition.FoodItem` row (or an `estimate` summed from rows). A guard test asserts a malicious/hallucinated numeric response never yields a persisted or returned nutrition number sourced from the LLM.
- **Stub-first:** no test in normal `go test` makes a live provider call. The router/resolver/cache/metering tests use a stub `ai.Provider`. Concrete Gemini/OpenAI adapters are exercised only by a keyed smoke (`-tags smoke` + env keys) — off by default.
- **Provider routing:** Gemini 2.5 Flash (photo identify), Gemini Flash-Lite (chat identify + decompose), Gemini `text-embedding-004` (embeddings, 768-dim); OpenAI GPT-5-mini fallback on provider error or latency-budget breach. Latency budgets: photo <3s, chat <1.5s.
- **Confidence tiers:** `tier = min(guess.Confidence, topCandidate.MatchScore)`; **≥0.90** auto-suggest, **0.70–0.90** one confirm, **<0.70** follow-up. Constants named, never silently changed.
- **Alias convention (carried from 2a):** aliases are matched/stored on **lower+trim** (NOT `Normalize`, to align with `idx_food_aliases_alias`). The correction loop MUST insert aliases lower/trim.
- **Embedding dimension 768** everywhere. The `embedding` column is raw-SQL-only (not a `FoodItem` struct field).
- **Redis optional:** the cache degrades to no-op when Redis is unavailable (matches the codebase's optional-Redis pattern). Never fail a resolve because the cache is down.
- **Errors:** wrap with `fmt.Errorf("ai: <op>: %w", err)` / `fmt.Errorf("billing: <op>: %w", err)`. Never silently swallow. No panics outside `main`.
- **Tests:** unit + integration; integration DB tests use `TEST_DATABASE_URL` and **skip** when Postgres/Redis unavailable. `go test -race -p 1`. `gofmt`/`go vet` clean. Conventional single-line commits, no signature.

## Existing code (grounding — read before Task 1)

- `api/internal/config/config.go` — `Config{Port, Env, DatabaseURL, RedisURL, FirebaseProjectID}`, `Load()`, `getenv`.
- `api/internal/nutrition` — `FoodItem`, `Provenance*`, `Repository.Resolve(ctx, phrase, queryVec []float32, limit) ([]Candidate, error)`, `Candidate{Item, MatchScore, MatchTier}`, `Insert`, `Normalize`, `food_aliases` (lower(alias) index).
- `api/internal/httpx` — `OK(c, data)` → `{"data": data}`; `Error(c, status, code, message)`.
- `api/internal/database` — embedded migrations (`//go:embed migrations/*.sql`), `Migrate`, `Connect`. Next migration `000006` (`000005` is the 2a FTS-index fix).
- `api/internal/server/router.go` — `Deps{DB, Verifier}`, GIP-auth `v1` group. (Resolve API endpoints are Phase 2c — NOT this plan.)

## File Structure

- Modify: `api/internal/config/config.go` (+ `GeminiAPIKey`, `OpenAIAPIKey`).
- Create: `api/internal/ai/types.go` (domain types), `api/internal/ai/provider.go` (interface + stub in tests), `api/internal/ai/router.go`, `api/internal/ai/resolver.go`, `api/internal/ai/cache.go`, `api/internal/ai/providers/gemini.go`, `api/internal/ai/providers/openai.go`, plus tests.
- Create: `api/internal/billing/` — `event.go` (model), `meter.go`, `meter_test.go`.
- Create: `api/internal/database/migrations/000006_ai_usage_events.up.sql` / `.down.sql`.
- Create: `api/cmd/embed/main.go` (embedding backfill).
- Modify: `api/go.mod` / `go.sum`.

---

## Task 1: Config keys + `ai` domain types + `Provider` interface

**Files:**
- Modify: `api/internal/config/config.go`, `api/internal/config/config_test.go`
- Create: `api/internal/ai/types.go`, `api/internal/ai/provider.go`
- Create: `api/internal/ai/provider_test.go`

**Interfaces:**
- Produces: `Config` gains `GeminiAPIKey`, `OpenAIAPIKey` (from `GEMINI_API_KEY`, `OPENAI_API_KEY`; empty allowed — engine degrades to manual). Domain types + the `Provider` interface (below).

- [ ] **Step 1: Add config keys (write failing test first)**

Add to `config_test.go` a case asserting `GeminiAPIKey`/`OpenAIAPIKey` load from env (extend the existing table test). Run `cd api && go test ./internal/config/` → FAIL. Then in `config.go` add the fields + `getenv`-style loads:
```go
	GeminiAPIKey:      os.Getenv("GEMINI_API_KEY"),
	OpenAIAPIKey:      os.Getenv("OPENAI_API_KEY"),
```
(and the struct fields). Do NOT make them required (empty = AI disabled). Re-run → PASS.

- [ ] **Step 2: Write the domain types**

Create `api/internal/ai/types.go`:
```go
// Package ai owns AI-assisted food resolution: provider clients, routing,
// and the resolution service. The LLM identifies foods; nutrition numbers
// always come from the nutrition index (never from the model).
package ai

// Guess is a single food identification from a provider. It carries NO
// nutrition numbers — only identity + portion + confidence.
type Guess struct {
	Food           string  `json:"food"`
	PortionEstimate string `json:"portion_estimate"`
	CookingMethod  string  `json:"cooking_method"`
	Confidence     float64 `json:"confidence"`
}

// IngredientGuess is a decomposed ingredient (identity + portion only).
type IngredientGuess struct {
	Ingredient      string  `json:"ingredient"`
	PortionEstimate string  `json:"portion_estimate"`
	Confidence      float64 `json:"confidence"`
}

// Usage records one provider call for metering.
type Usage struct {
	Provider  string
	Model     string
	CallType  string // identify_text | identify_photo | decompose | embed
	TokensIn  int
	TokensOut int
	LatencyMs int
}

// Tier classifies resolution confidence.
type Tier string

const (
	TierAuto      Tier = "auto"       // >= 0.90 one-tap
	TierConfirm   Tier = "confirm"    // 0.70-0.90 one quick confirm
	TierFollowUp  Tier = "follow_up"  // < 0.70 targeted question
)

const (
	tierAutoFloor    = 0.90
	tierConfirmFloor = 0.70
)

// TierFor combines LLM identify-confidence with the top resolution match
// score (the limiting one wins).
func TierFor(identifyConf, matchScore float64) Tier {
	c := identifyConf
	if matchScore < c {
		c = matchScore
	}
	switch {
	case c >= tierAutoFloor:
		return TierAuto
	case c >= tierConfirmFloor:
		return TierConfirm
	default:
		return TierFollowUp
	}
}
```

- [ ] **Step 3: Write the `Provider` interface (test first)**

Create `api/internal/ai/provider_test.go` with a `stubProvider` implementing the interface + a `TestTierFor` table test (0.95→auto, 0.8→confirm, 0.5→follow_up, and min-wins: identify 0.95 + match 0.6 → follow_up). Run → FAIL (interface undefined). Then create `api/internal/ai/provider.go`:
```go
package ai

import "context"

// Provider is a single AI backend. Implementations (Gemini, OpenAI) are thin
// adapters; all higher layers depend only on this interface so they are
// testable without live calls.
type Provider interface {
	IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error)
	IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error)
	Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error)
	Embed(ctx context.Context, text string) ([]float32, Usage, error)
	Name() string
}
```
Run → PASS.

- [ ] **Step 4: Add SDK + redis deps (no usage yet — indirect until later tasks)**

```bash
cd api && go get google.golang.org/genai@latest github.com/openai/openai-go@latest github.com/redis/go-redis/v9@latest
```

- [ ] **Step 5: `gofmt`/`vet`/commit**

Run: `cd api && gofmt -l . && go vet ./internal/config/ ./internal/ai/ && go test ./internal/config/ ./internal/ai/`
Expected: clean + PASS. Commit:
```bash
git add api/internal/config api/internal/ai/types.go api/internal/ai/provider.go api/internal/ai/provider_test.go api/go.mod api/go.sum
git commit -m "feat(api): ai domain types, Provider interface, config keys, sdk deps"
```

---

## Task 2: Router with fallback

**Files:**
- Create: `api/internal/ai/router.go`, `api/internal/ai/router_test.go`

**Interfaces:**
- Produces: `Router{Primary, Fallback Provider; budgets}` implementing `Provider`. Each method calls `Primary`; on error OR when the call exceeds the per-call-type latency budget (enforced via `context.WithTimeout`), it retries on `Fallback`. Records which provider served (in `Usage.Provider`). If both fail, returns the fallback's error.

- [ ] **Step 1: Write the failing test**

`router_test.go`: two `stubProvider`s. Cases: (a) primary succeeds → primary's result, fallback untouched; (b) primary returns error → fallback's result; (c) primary blocks past the budget (stub sleeps via a channel / honors ctx) → fallback's result; (d) both error → error returned. Assert `Usage.Provider` reflects who served. Run → FAIL.

- [ ] **Step 2: Implement `router.go`**

`Router` implements each `Provider` method with a helper `withFallback(callType, primaryFn, fallbackFn)` that applies `context.WithTimeout` (photo 3s, text/decompose/embed 1.5s), tries primary, and on error/deadline tries fallback. Budgets are named consts. Full method set (IdentifyText/IdentifyPhoto/Decompose/Embed/Name). Run → PASS.

- [ ] **Step 3: commit**
```bash
git add api/internal/ai/router.go api/internal/ai/router_test.go
git commit -m "feat(api): ai provider router with latency + error fallback"
```

---

## Task 3: Metering (`billing`) + migration 000005

**Files:**
- Create: `api/internal/database/migrations/000006_ai_usage_events.up.sql` / `.down.sql`
- Create: `api/internal/billing/event.go`, `meter.go`, `meter_test.go`

**Interfaces:**
- Produces: `ai_usage_events` table. `billing.Meter{db}` with `Record(ctx, userID uuid.UUID, u ai.Usage, costUSD float64) error` and `WithinBudget(ctx, userID uuid.UUID) (bool, error)` (per-user + global monthly cap constants; over cap → false). `Event` model.

- [ ] **Step 1: Migration**
`000006_ai_usage_events.up.sql`:
```sql
CREATE TABLE ai_usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    call_type TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    cost_usd_est DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_user_created ON ai_usage_events (user_id, created_at);
```
`.down.sql`: `DROP TABLE IF EXISTS ai_usage_events;`

- [ ] **Step 2: Test-first**
`meter_test.go` (DB integration, skip if no DB): `Record` inserts a row (verify fields); `WithinBudget` returns true under the cap and false once monthly cost/count exceeds the cap (insert synthetic events to cross it). Run → FAIL.

- [ ] **Step 3: Implement `event.go` + `meter.go`**
`Event` GORM model on `ai_usage_events`; `Meter.Record` inserts; `WithinBudget` sums this-month `cost_usd_est` (and/or counts) for the user + globally against named-const caps. Wrap errors. Run → PASS. Commit `feat(api): ai usage metering + monthly budget`.

---

## Task 4: Redis cache (optional, nil-safe)

**Files:**
- Create: `api/internal/ai/cache.go`, `api/internal/ai/cache_test.go`

**Interfaces:**
- Produces: `Cache` interface `{ Get(ctx, key) (*Resolution, bool); Set(ctx, key string, r Resolution) }` with `RedisCache` (wraps `*redis.Client`, JSON values, TTL) and `NoCache` (no-op). `CacheKey(kind, value string) string` (`kind:barcode|phrase|photo`). A cache miss/Redis error is never fatal — treated as "not cached".

- [ ] **Step 1: Test-first**
`cache_test.go`: `NoCache` always misses; `CacheKey` stable/normalized; with `miniredis` (add `github.com/alicebob/miniredis/v2` as a test dep) a `Set` then `Get` round-trips a `Resolution`, and a Get on a down client returns miss without error. Run → FAIL.

- [ ] **Step 2: Implement `cache.go`**
(Requires `Resolution` from Task 5 — define a minimal `Resolution` stub in Task 5 first, or land Task 5's types before this. Order note: implement Task 5 Step 2 (types) before Task 4 if needed.) Run → PASS. Commit `feat(api): optional redis cache for resolutions`.

---

## Task 5: Resolution service + invariant guard

**Files:**
- Create: `api/internal/ai/resolver.go`, `api/internal/ai/resolver_test.go`

**Interfaces:**
- Consumes: `Provider` (router), `nutrition.Repository`, `Cache`, `billing.Meter`.
- Produces:
  - `Resolution{Candidates []ResolvedCandidate; Tier Tier; FollowUpQuestion string; IsEstimate bool; KcalLow, KcalHigh float64; Provenance string}`.
  - `ResolvedCandidate{Item nutrition.FoodItem; PortionGrams float64; Kcal float64; MatchScore float64; MatchTier string}` — Kcal computed from the row's per-100g × grams (NEVER from the LLM).
  - `Resolver.ResolveText(ctx, userID, phrase) (Resolution, error)`, `ResolveBarcode(...)`, and (photo) `ResolvePhoto(...)`.
  - Flow: cache check → `Provider.Identify*` → for each guess: `Provider.Embed(food)` → `nutrition.Resolve(food, vec, k)` → build `ResolvedCandidate` (portion parsed to grams; kcal from row) → `TierFor`. Unknown (no candidate ≥ confirm floor) → `Provider.Decompose` → sum ingredient rows → `IsEstimate=true`, `KcalLow/High = sum × (1∓0.15)`. Record `Meter`. Cache the result.
  - **Invariant guard:** the provider `Guess`/`IngredientGuess` types carry no numeric nutrition; the resolver reads kcal/macros ONLY from `nutrition.FoodItem`. A test feeds a stub provider returning a `Guess` (identity only) and asserts the resolved kcal equals the DB row's computed value, and that there is no code path reading a number off the provider response.

- [ ] **Step 1: parse portion helper (test-first)**
`parsePortionGrams(s string) float64` — maps common portion phrases ("100 g", "1 cup", "1 breast", "medium") to grams with sane defaults; unit-tested table.
- [ ] **Step 2: `Resolution`/`ResolvedCandidate` types** (also unblocks Task 4).
- [ ] **Step 3: resolver test-first** — stub provider (identity-only guesses) + seeded DB; assert: high-confidence guess + strong match → `TierAuto`, kcal from row; low match → `TierFollowUp` with a question; unknown dish → decompose path → `IsEstimate` + kcal range; the **invariant guard** test. Run → FAIL.
- [ ] **Step 4: implement `resolver.go`** → PASS. Commit `feat(api): resolution service with confidence tiers, decomposition, invariant guard`.

---

## Task 6: Gemini provider adapter

**Files:**
- Create: `api/internal/ai/providers/gemini.go`, `api/internal/ai/providers/gemini_test.go`

**Interfaces:**
- Produces: `GeminiProvider` implementing `ai.Provider` via `google.golang.org/genai`. `IdentifyText`/`Decompose` use Flash-Lite; `IdentifyPhoto` uses Flash; `Embed` uses `text-embedding-004` (768-dim). Structured JSON output constrained to the `Guess`/`IngredientGuess` shape (identity/portion/confidence ONLY — no nutrition fields in the schema).

- [ ] **Step 1: Consult the installed SDK.** Read `google.golang.org/genai` docs/godoc for the installed version (client construction with an API key, generating content with a JSON response schema, multimodal image input, and embeddings). **Do NOT guess the API** — verify method names/shapes against the vendored package (`go doc google.golang.org/genai`). If the SDK's API differs from this plan's assumptions, adapt the adapter and note it.
- [ ] **Step 2: Implement `GeminiProvider`** mapping each `ai.Provider` method to the SDK. The response JSON schema MUST exclude any nutrition-number field (identity + portion + confidence only), enforcing the invariant at the schema boundary. Parse tokens/latency into `Usage`.
- [ ] **Step 3: Unit tests without live calls** — assert the request-building (model selection per call type, the JSON schema shape has no nutrition fields) and response parsing on a hand-written sample JSON, via any injectable seam the SDK offers (or a small internal `parseGuesses([]byte)` helper you unit-test directly). Do NOT call the network in `go test`.
- [ ] **Step 4: commit** `feat(api): gemini provider adapter (identify/decompose/embed)`.

---

## Task 7: OpenAI provider adapter (fallback)

**Files:**
- Create: `api/internal/ai/providers/openai.go`, `api/internal/ai/providers/openai_test.go`

**Interfaces:**
- Produces: `OpenAIProvider` implementing `ai.Provider` via `github.com/openai/openai-go` with GPT-5-mini for identify/decompose and an OpenAI embedding model for `Embed` (or return an error for `Embed` so the router keeps embeddings on Gemini — pick per the SDK; document the choice). Same identity-only structured output + invariant.

- [ ] **Step 1: Consult the installed `openai-go` SDK** (`go doc github.com/openai/openai-go`) — client init, structured/JSON output, vision input. Adapt to the real API.
- [ ] **Step 2: Implement** the adapter; identity/portion/confidence-only schema.
- [ ] **Step 3: Unit tests** (parse-helper + request-shape, no network).
- [ ] **Step 4: commit** `feat(api): openai provider adapter (fallback)`.

---

## Task 8: Embedding backfill command + query-embedding wiring

**Files:**
- Create: `api/cmd/embed/main.go`
- Modify: `api/internal/nutrition/repository.go` (add `RowsMissingEmbedding` + `SetEmbedding` raw-SQL helpers) + test

**Interfaces:**
- Produces:
  - `nutrition.Repository.RowsMissingEmbedding(ctx, limit) ([]FoodItem, error)` (raw `WHERE embedding IS NULL`) and `SetEmbedding(ctx, id uuid.UUID, vec []float32) error` (raw `UPDATE ... SET embedding = ?` via `pgvector.NewVector`).
  - `cmd/embed` — connects DB, builds the Gemini provider from config, iterates rows missing embeddings, calls `Embed(name)`, stores. Requires `GEMINI_API_KEY` (logs a clear message + exits 0 if absent — no crash).

- [ ] **Step 1: repo helpers (test-first)** — integration test: insert a row, `SetEmbedding` a 768-vector, assert `RowsMissingEmbedding` no longer returns it and the embedding tier of `Resolve` (with a near query vector) now returns it. Run → FAIL → implement → PASS.
- [ ] **Step 2: `cmd/embed`** — wire config + provider + repo loop. Build only (no live run in CI). 
- [ ] **Step 3: commit** `feat(api): embedding backfill command + repo embedding helpers`.

---

## Self-Review (spec §3 / Phase 2b coverage)

- Provider clients + routing + fallback → Tasks 1,2,6,7. ✓
- Structured identification (identity/portion only) → Tasks 1,6,7 (schema excludes nutrition). ✓
- Index resolution + confidence tiers + decomposition + portion ranges → Task 5 (reuses 2a `Resolve`). ✓
- Caching → Task 4 (optional/nil-safe). ✓
- Metering + budget → Task 3. ✓
- Hard invariant (LLM never emits stored numbers) → enforced by types (no numeric fields) + schema + Task 5 guard test. ✓
- Embedding tier lit up → Task 8 (backfill + query embedding; real vectors need keys). ✓
- Correction loop (alias update on correction, lower/trim) → **deferred to Phase 2c** where the resolve/correct API endpoints land (note: use lower/trim per 2a). 
- Stub-first (no live calls in CI) → all tests use stubs; adapters verified by parse-helpers + a keyed `-tags smoke`. ✓

## Prerequisites / follow-ups

- `GEMINI_API_KEY` + `OPENAI_API_KEY` in `api/.env` before `cmd/embed`, the keyed smoke, and Phase 2c's eval. (Absent today — engine builds + unit-tests without them.)
- SDK APIs (`google.golang.org/genai`, `openai-go`) must be verified against the installed versions in Tasks 6/7 — the adapters are the only SDK-coupled code; adapt if the real API differs from this plan's assumptions.
- Phase 2c: resolve API endpoints (`/v1/resolve/*`), the eval harness + golden dataset, and the correction loop.
