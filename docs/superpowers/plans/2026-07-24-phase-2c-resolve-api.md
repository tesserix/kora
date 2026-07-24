# Phase 2c — Resolve API + Free-Fallback Wiring + Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the Phase 2b `ai` engine behind live `POST /v1/resolve/{text,photo,barcode}` endpoints, wire the FREE fallback (NVIDIA via the OpenAI-compatible adapter), make the budget gate functional (list-price cost + per-user call-count cap), add a full log-edit endpoint with a correction alias loop, backfill embeddings, and scaffold the eval harness.

**Architecture:** The `ai` package (Router→Gemini primary, OpenAI-compatible fallback; Resolver; Cache; Meter) is composed in `cmd/api/main.go` from config and injected into the router via `server.Deps`. A new `internal/resolve` handler package exposes the three resolve endpoints over the existing GIP-auth `v1` group, depending on small interfaces so it is unit-testable without live LLM calls. The hard invariant (LLM never emits a stored nutrition number) is already enforced structurally in `ai`/`nutrition`; this phase only exposes it over HTTP and never introduces a nutrition number from a request body. Nutrition on every resolved/edited row is always `row.KcalPer100g × grams / 100`.

**Tech Stack:** Go 1.26; Gin; GORM/Postgres (pgvector); `google.golang.org/genai` (Gemini primary, live-verified free tier); `github.com/openai/openai-go` (OpenAI-compatible fallback, base URL configurable → NVIDIA NIM); `github.com/redis/go-redis/v9` (optional cache); testify. Keys via env in `api/.env` (gitignored).

## Global Constraints

- **Hard invariant (enforced structurally + tested):** every nutrition number in any response comes from a `nutrition.FoodItem` row via `KcalPer100g × grams / 100` (or a decomposed sum of rows). No request body or LLM field ever supplies kcal/macros. New endpoints MUST NOT accept or trust a client-supplied nutrition number.
- **No live LLM calls in normal `go test`.** Handler/router/service tests use stubs. Live provider exercise happens only in `//go:build smoke` and `//go:build eval` runs and in controller-run curl smokes.
- **Free-first provider stack:** primary = Gemini (free tier). Models are the live-verified IDs already in code: `gemini-3.5-flash` (photo), `gemini-3.5-flash-lite` (text/decompose), `gemini-embedding-001` @ `OutputDimensionality=768`. Fallback = NVIDIA `meta/llama-3.3-70b-instruct` via the OpenAI-compatible adapter at `https://integrate.api.nvidia.com/v1`, using `response_format:{type:"json_object"}` (NVIDIA strict `json_schema` works but is ~29s slow and yields degenerate values — verified live 2026-07-24). Fallback is OPTIONAL: Gemini-only when no fallback key is set.
- **Alias convention (carried from 2a):** aliases are matched/stored on **lower+trim** only (NOT `nutrition.Normalize`), to align with `idx_food_aliases_alias ON food_aliases (lower(alias))`.
- **Embedding dimension 768** everywhere; the `embedding` column is raw-SQL-only.
- **Redis optional:** cache degrades to `NoCache` when Redis is unreachable. Never fail a resolve because the cache is down.
- **Budget gate (this phase makes it live):** `estimateCostUSD` uses a per-model **list-price proxy** rate table (nonzero even though you pay $0 on free tier) so `WithinBudget` throttles heavy users to protect free-tier quota; PLUS a per-user monthly **call-count** cap. Both the existing $5/user & $500/global monthly $ caps remain.
- **Errors:** wrap with `fmt.Errorf("<pkg>: <op>: %w", err)`. Never silently swallow. Infra errors → 500 generic via `httpx.RespondServiceError`; validation → 400. No panics outside `main`.
- **Tests:** `cd api && go test -race -p 1 ./...`, run FOREGROUND. Integration/DB tests SKIP (not fail) when Postgres/Redis unavailable. `gofmt -l .` and `go vet ./...` clean. Conventional single-line commits, no signature.
- **Local env:** `DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable'` (pgvector/pgvector:pg15, db `kora`, ~85 food rows). Keys live in `api/.env`.

## Existing code (grounding — read before Task 1)

- `api/internal/ai/` — `Provider` interface, `Router{Primary,Fallback}`, `Resolver` (`ResolveText`/`ResolvePhoto`; NO `ResolveBarcode`), `Cache`/`NoCache`/`RedisCache`, `CacheKey`, `Resolution`/`ResolvedCandidate`, `Meter` interface, `TierFor`, `estimateCostUSD` (returns `0.0` in `resolver.go`).
- `api/internal/ai/providers/` — `NewGeminiProvider(ctx, apiKey) (GeminiProvider, error)`; `NewOpenAIProvider(apiKey string) OpenAIProvider` (strict `json_schema` only; `Embed` errors by design). Shared `parseGuesses`/`parseIngredients`, `guessJSONSchema`/`ingredientJSONSchema`, `identifySystemPrompt`, `decomposeSystemPromptTmpl`.
- `api/internal/billing/` — `Event` (GORM `ai_usage_events`; `UserID` has NO `json:"-"`), `Meter{db}` with `Record(ctx, userID, ai.Usage, costUSD) error` and `WithinBudget(ctx, userID) (bool, error)` (per-user $5 + global $500 calendar-month caps).
- `api/internal/nutrition/` — `Repository.Resolve(ctx, phrase, queryVec, limit) ([]Candidate, error)`, `ResolveBarcode(ctx, off, code) (*FoodItem, bool, error)`, `GetByID`, `Insert`, `Normalize`, `RowsMissingEmbedding`, `SetEmbedding`. `OFFClient` interface + `NewHTTPOFFClient() HTTPOFFClient`. `food_aliases` index is **non-unique** `lower(alias)` (no unique constraint).
- `api/internal/foodlog/` — `Service.LogFood` computes nutrition from the row (`f := grams/100; kcal = item.KcalPer100g*f`; sets `Description = item.Name`). `Repository` has Create/List/GetByID/Delete/LoggedDaysDesc (NO Update). `Handler` routes create/list/delete/copy-day/repeat. `FoodLog.UserID` has `json:"-"`.
- `api/internal/user/` — `IDFromContext(c) (uuid.UUID, bool)`, `ResolveMiddleware(repo)`.
- `api/internal/httpx/` — `OK(c, data)` → `{"data": ...}`; `Error(c, status, code, message)`; `ValidationError`; `RespondServiceError(c, err)`.
- `api/internal/server/router.go` — `Deps{DB, Verifier}`; builds handlers when `DB != nil && Verifier != nil`; GIP-auth `v1` group with `user.ResolveMiddleware`.
- `api/cmd/api/main.go` — loads config, migrates, connects DB, builds Firebase verifier, `server.NewRouter(Deps{DB, Verifier})`.

## File Structure

- Modify: `api/internal/billing/event.go` (`UserID json:"-"`), `api/internal/billing/meter.go` (+ call-count cap), `api/internal/billing/meter_test.go`.
- Create: `api/internal/ai/pricing.go` (list-price rate table + `EstimateCostUSD`), `api/internal/ai/pricing_test.go`. Modify: `api/internal/ai/resolver.go` (use `EstimateCostUSD`; skip metering on embed error).
- Create: `api/internal/database/migrations/000007_ai_usage_created_idx.up.sql` / `.down.sql`.
- Modify: `api/internal/config/config.go` (+ `OpenAIBaseURL`, `OpenAIModel`, `OpenAIJSONObject`), `config_test.go`.
- Modify: `api/internal/ai/providers/openai.go` (base URL + model + `json_object` compat path), `openai_test.go`; `api/internal/ai/providers/smoke_test.go` (NVIDIA smoke, `//go:build smoke`).
- Create: `api/internal/resolve/handler.go`, `api/internal/resolve/handler_test.go`.
- Modify: `api/internal/server/router.go` (+ resolve routes, extend `Deps`), `router_test.go`.
- Modify: `api/cmd/api/main.go` (compose ai engine).
- Create: `api/internal/nutrition/alias.go` (`AddAlias`), `alias_test.go`.
- Modify: `api/internal/foodlog/repository.go` (+ `Update`), `service.go` (+ `EditLog`), `handler.go` (+ `Update`/PATCH), plus tests. Modify `api/internal/server/router.go` (PATCH route).
- Create: `api/internal/ai/eval_test.go` (`//go:build eval`), `api/testdata/eval/README.md`, `api/testdata/eval/chat.sample.jsonl`, `api/testdata/eval/.gitignore`.

---

## Task 1: Live budget gate — list-price pricing, call-count cap, metering hygiene

**Files:**
- Create: `api/internal/ai/pricing.go`, `api/internal/ai/pricing_test.go`
- Modify: `api/internal/ai/resolver.go`
- Modify: `api/internal/billing/meter.go`, `api/internal/billing/meter_test.go`
- Modify: `api/internal/billing/event.go`
- Create: `api/internal/database/migrations/000007_ai_usage_created_idx.up.sql`, `.down.sql`

**Interfaces:**
- Consumes: `ai.Usage{Provider, Model, TokensIn, TokensOut}`.
- Produces: `ai.EstimateCostUSD(u Usage) float64` (exported; list-price proxy). `billing.Meter.WithinBudget` additionally returns false once the per-user monthly **call count** ≥ `perUserMonthlyCallCap`. `Event.UserID` gains `json:"-"`.

- [ ] **Step 1: Write the failing pricing test**

Create `api/internal/ai/pricing_test.go`:
```go
package ai

import (
	"math"
	"testing"
)

func TestEstimateCostUSDKnownModel(t *testing.T) {
	// gemini-3.5-flash-lite: $0.10/1M in, $0.40/1M out (list-price proxy).
	// 1000 in + 500 out => 1000/1e6*0.10 + 500/1e6*0.40 = 0.0001 + 0.0002 = 0.0003
	got := EstimateCostUSD(Usage{Model: "gemini-3.5-flash-lite", TokensIn: 1000, TokensOut: 500})
	if math.Abs(got-0.0003) > 1e-9 {
		t.Fatalf("flash-lite cost = %v, want 0.0003", got)
	}
}

func TestEstimateCostUSDUnknownModelUsesDefaultNonzero(t *testing.T) {
	got := EstimateCostUSD(Usage{Model: "some-future-model", TokensIn: 1_000_000, TokensOut: 0})
	if got <= 0 {
		t.Fatalf("unknown model cost = %v, want > 0 (default proxy rate)", got)
	}
}

func TestEstimateCostUSDNVIDIAFallback(t *testing.T) {
	// meta/llama-3.3-70b-instruct: $0.60/1M in + out.
	got := EstimateCostUSD(Usage{Model: "meta/llama-3.3-70b-instruct", TokensIn: 1_000_000, TokensOut: 1_000_000})
	if math.Abs(got-1.20) > 1e-9 {
		t.Fatalf("nvidia cost = %v, want 1.20", got)
	}
}
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd api && go test ./internal/ai/ -run TestEstimateCostUSD -v`
Expected: FAIL — `EstimateCostUSD` undefined (currently `estimateCostUSD` is unexported in `resolver.go` and returns 0.0).

- [ ] **Step 3: Implement `pricing.go`**

Create `api/internal/ai/pricing.go`:
```go
package ai

// modelPrice is a per-model token price in USD per 1,000,000 tokens.
//
// These are LIST-PRICE PROXIES, not amounts actually billed: the live stack
// runs on free tiers (Gemini free, NVIDIA NIM free) where real spend is $0.
// Pricing calls at their paid list rate lets the monthly $ budget cap
// (billing.Meter.WithinBudget) throttle a heavy user before they exhaust the
// free-tier quota that protects everyone else. Values are approximate public
// list rates as of 2026-07 and can drift without affecting correctness — they
// only shape the throttle threshold.
type modelPrice struct {
	inPerM  float64
	outPerM float64
}

var modelPrices = map[string]modelPrice{
	"gemini-3.5-flash":         {inPerM: 0.30, outPerM: 2.50},
	"gemini-3.5-flash-lite":    {inPerM: 0.10, outPerM: 0.40},
	"gemini-embedding-001":     {inPerM: 0.15, outPerM: 0.0},
	"meta/llama-3.3-70b-instruct": {inPerM: 0.60, outPerM: 0.60},
	"gpt-5-mini":               {inPerM: 0.25, outPerM: 2.00},
}

// defaultModelPrice is used for any model not in modelPrices, so an unrecognized
// model is never treated as free (which would silently disable the budget gate).
var defaultModelPrice = modelPrice{inPerM: 0.50, outPerM: 1.50}

// EstimateCostUSD returns the list-price-proxy USD cost of one provider call.
func EstimateCostUSD(u Usage) float64 {
	p, ok := modelPrices[u.Model]
	if !ok {
		p = defaultModelPrice
	}
	return float64(u.TokensIn)/1_000_000*p.inPerM + float64(u.TokensOut)/1_000_000*p.outPerM
}
```

- [ ] **Step 4: Replace the inert `estimateCostUSD` in `resolver.go`**

In `api/internal/ai/resolver.go`, DELETE the `estimateCostUSD` function (the one returning `0.0`, ~lines 68-74) and change `record` to call the new exported function:
```go
// record meters one provider call. Metering failures must never break
// resolution — a user's food logging cannot depend on the billing table
// being reachable — so the error is deliberately ignored here.
func (r Resolver) record(ctx context.Context, userID uuid.UUID, u Usage) {
	_ = r.meter.Record(ctx, userID, u, EstimateCostUSD(u))
}
```

- [ ] **Step 5: Metering hygiene — don't record a noise row when Embed errored**

In `resolver.go`, in BOTH `resolveGuesses` and `decomposeAndEstimate`, the embed usage is currently recorded before checking the error. Change both occurrences from:
```go
		vec, embUsage, embErr := r.provider.Embed(ctx, guess.Food) // (or ing.Ingredient)
		r.record(ctx, userID, embUsage)
		if embErr != nil {
			vec = nil
		}
```
to (record only on success):
```go
		vec, embUsage, embErr := r.provider.Embed(ctx, guess.Food) // (or ing.Ingredient)
		if embErr != nil {
			// A failed embed contributes no real usage and must not create a
			// noise metering row; the embedding tier is simply skipped.
			vec = nil
		} else {
			r.record(ctx, userID, embUsage)
		}
```

- [ ] **Step 6: Run the ai package tests**

Run: `cd api && go test -race -p 1 ./internal/ai/ -v`
Expected: PASS (pricing tests green; resolver tests still green — the guard test asserts kcal from row, unaffected).

- [ ] **Step 7: `Event.UserID json:"-"` (failing test first)**

Add to `api/internal/billing/meter_test.go`:
```go
func TestEventJSONOmitsUserID(t *testing.T) {
	b, err := json.Marshal(Event{UserID: uuid.New(), Provider: "gemini"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "user_id") {
		t.Fatalf("Event JSON leaked user_id: %s", b)
	}
}
```
Add `"encoding/json"`, `"strings"`, and (if missing) `"github.com/google/uuid"` to the test imports. Run: `cd api && go test ./internal/billing/ -run TestEventJSONOmitsUserID` → FAIL (contains `user_id`).

Then in `api/internal/billing/event.go` change:
```go
	UserID     uuid.UUID `json:"user_id"`
```
to:
```go
	UserID     uuid.UUID `json:"-"`
```
Re-run → PASS.

- [ ] **Step 8: Per-user monthly call-count cap (failing test first)**

Add to `api/internal/billing/meter_test.go` (this is a DB integration test — follow the existing skip-if-no-DB pattern already used by the other meter tests in this file; reuse the same test-DB setup helper the file already defines):
```go
func TestWithinBudgetCallCountCap(t *testing.T) {
	db := testDB(t) // existing helper in this test file; it skips if no TEST_DATABASE_URL
	m := NewMeter(db)
	ctx := context.Background()
	uid := seedUser(t, db) // existing helper; creates a users row and returns its id

	// Insert exactly the cap number of zero-cost calls this month.
	for i := 0; i < perUserMonthlyCallCap; i++ {
		if err := m.Record(ctx, uid, ai.Usage{Provider: "gemini", Model: "gemini-3.5-flash-lite", CallType: "identify_text"}, 0); err != nil {
			t.Fatal(err)
		}
	}
	ok, err := m.WithinBudget(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("WithinBudget = true at %d calls, want false (call-count cap)", perUserMonthlyCallCap)
	}
}
```
> If the existing meter_test.go names its DB/user helpers differently, use those names — do not invent parallel helpers. Read the file first.

Run: `cd api && go test ./internal/billing/ -run TestWithinBudgetCallCountCap` → FAIL (`perUserMonthlyCallCap` undefined; call count not enforced).

- [ ] **Step 9: Implement the call-count cap in `meter.go`**

In `api/internal/billing/meter.go`, add the const alongside the existing caps:
```go
	// perUserMonthlyCallCap bounds how many AI calls a single user may make in
	// a calendar month, protecting free-tier provider quota even when the
	// list-price cost estimate stays under the dollar cap.
	perUserMonthlyCallCap = 300
```
Then in `WithinBudget`, AFTER the per-user cost check and BEFORE the global cost check, add:
```go
	var userCalls int64
	if err := m.db.WithContext(ctx).
		Model(&Event{}).
		Where("user_id = ? AND created_at >= ?", userID, monthStart).
		Count(&userCalls).Error; err != nil {
		return false, fmt.Errorf("billing: within budget: count user calls: %w", err)
	}
	if userCalls >= perUserMonthlyCallCap {
		return false, nil
	}
```
Run: `cd api && go test -race -p 1 ./internal/billing/` → PASS (or SKIP if no DB). Confirm at least the non-DB `TestEventJSONOmitsUserID` passes.

- [ ] **Step 10: Migration 000007 — index for global/count scans**

Create `api/internal/database/migrations/000007_ai_usage_created_idx.up.sql`:
```sql
-- Global monthly SUM and per-user COUNT in billing.WithinBudget filter on
-- created_at; a plain created_at index avoids a seq scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events (created_at);
```
Create `api/internal/database/migrations/000007_ai_usage_created_idx.down.sql`:
```sql
DROP INDEX IF EXISTS idx_ai_usage_created;
```
Run the migration test suite (whatever verifies migrations apply/reverse — the existing `database` package test): `cd api && go test -race -p 1 ./internal/database/` → PASS (or SKIP without DB).

- [ ] **Step 11: gofmt/vet + commit**

Run: `cd api && gofmt -l . && go vet ./internal/ai/ ./internal/billing/ ./internal/database/ && go test -race -p 1 ./internal/ai/ ./internal/billing/ ./internal/database/`
Expected: no gofmt output, vet clean, tests PASS/SKIP.
```bash
git add api/internal/ai/pricing.go api/internal/ai/pricing_test.go api/internal/ai/resolver.go api/internal/billing api/internal/database/migrations/000007_ai_usage_created_idx.up.sql api/internal/database/migrations/000007_ai_usage_created_idx.down.sql
git commit -m "feat(api): live budget gate — list-price cost, per-user call cap, event json fix"
```

---

## Task 2: OpenAI-compatible fallback — configurable base URL/model + json_object compat path

**Files:**
- Modify: `api/internal/config/config.go`, `api/internal/config/config_test.go`
- Modify: `api/internal/ai/providers/openai.go`, `api/internal/ai/providers/openai_test.go`
- Create: `api/internal/ai/providers/smoke_test.go`

**Interfaces:**
- Consumes: `Config` gains `OpenAIBaseURL` (`OPENAI_BASE_URL`), `OpenAIModel` (`OPENAI_MODEL`), `OpenAIJSONObject` (`OPENAI_JSON_OBJECT` == "true").
- Produces: `providers.NewOpenAIProvider(apiKey, baseURL, model string, jsonObject bool) OpenAIProvider`. When `baseURL != ""`, the SDK client uses it (`option.WithBaseURL`). When `model == ""`, defaults to `gpt-5-mini`. When `jsonObject == true`, requests use `response_format:{type:"json_object"}` and the JSON envelope shape is described in the system prompt (since json_object does not enforce a schema); otherwise strict `json_schema` (unchanged).

- [ ] **Step 1: Config keys (failing test first)**

In `api/internal/config/config_test.go`, extend the existing env-driven table/case to set and assert the three new fields (follow the file's existing pattern for setting env + asserting `cfg.Field`):
```go
	t.Setenv("OPENAI_BASE_URL", "https://integrate.api.nvidia.com/v1")
	t.Setenv("OPENAI_MODEL", "meta/llama-3.3-70b-instruct")
	t.Setenv("OPENAI_JSON_OBJECT", "true")
	// ... after Load():
	// assert cfg.OpenAIBaseURL == "https://integrate.api.nvidia.com/v1"
	// assert cfg.OpenAIModel == "meta/llama-3.3-70b-instruct"
	// assert cfg.OpenAIJSONObject == true
```
Run: `cd api && go test ./internal/config/` → FAIL (fields undefined).

- [ ] **Step 2: Add the config fields**

In `api/internal/config/config.go`, add to the `Config` struct:
```go
	OpenAIBaseURL    string
	OpenAIModel      string
	OpenAIJSONObject bool
```
and in `Load()`:
```go
		OpenAIBaseURL:    os.Getenv("OPENAI_BASE_URL"),
		OpenAIModel:      os.Getenv("OPENAI_MODEL"),
		OpenAIJSONObject: os.Getenv("OPENAI_JSON_OBJECT") == "true",
```
Run: `cd api && go test ./internal/config/` → PASS.

- [ ] **Step 3: Adapter — failing request-shape tests**

In `api/internal/ai/providers/openai_test.go`, add tests that exercise the request-building without a network call. Two behaviors to lock in:
  1. `NewOpenAIProvider(key, "", "", false)` keeps strict `json_schema` and default model `gpt-5-mini`.
  2. `NewOpenAIProvider(key, baseURL, "meta/llama-3.3-70b-instruct", true)` selects the configured model and the `json_object` response format, and the effective system prompt includes the JSON envelope instruction.

Since `openai.ChatCompletionNewParams` is built inside `generateJSON`, extract the param-building into a pure helper you can assert on. Add tests:
```go
func TestBuildParamsStrictSchemaDefault(t *testing.T) {
	p := NewOpenAIProvider("k", "", "", false)
	params := p.buildParams(modelDefault(p), "sys", nil, "food_guesses", guessJSONSchema())
	if params.Model != "gpt-5-mini" {
		t.Fatalf("model = %q, want gpt-5-mini", params.Model)
	}
	if params.ResponseFormat.OfJSONSchema == nil {
		t.Fatalf("expected strict json_schema response format")
	}
}

func TestBuildParamsJSONObjectCompat(t *testing.T) {
	p := NewOpenAIProvider("k", "https://integrate.api.nvidia.com/v1", "meta/llama-3.3-70b-instruct", true)
	params := p.buildParams(modelDefault(p), "sys", nil, "food_guesses", guessJSONSchema())
	if params.Model != "meta/llama-3.3-70b-instruct" {
		t.Fatalf("model = %q, want configured model", params.Model)
	}
	if params.ResponseFormat.OfJSONObject == nil {
		t.Fatalf("expected json_object response format for compat mode")
	}
	// The schema is not enforced by json_object, so its shape must be described
	// to the model in the system message.
	sys := systemTextOf(t, params)
	if !strings.Contains(sys, "\"guesses\"") {
		t.Fatalf("compat system prompt missing envelope shape hint: %q", sys)
	}
}
```
Add a small test helper `systemTextOf` that reads back the first system message's text from `params.Messages`, and `modelDefault(p)` returning `p.model` (see Step 4). Run → FAIL (`buildParams`/fields undefined).

> Verify the exact openai-go union field names (`ResponseFormat.OfJSONObject` vs `OfJSONSchema`, and how to construct a json_object response format) against the installed SDK with `cd api && go doc github.com/openai/openai-go` and `go doc github.com/openai/openai-go/shared` BEFORE writing the impl — adapt names if the installed v1.12.0 differs.

- [ ] **Step 4: Implement configurable adapter + compat path**

In `api/internal/ai/providers/openai.go`:

Change the struct and constructor to carry base URL / model / mode:
```go
type OpenAIProvider struct {
	client     openai.Client
	model      string
	jsonObject bool
}

// NewOpenAIProvider builds the OpenAI-compatible FALLBACK provider. baseURL,
// when non-empty, points the client at any OpenAI-compatible endpoint (e.g.
// NVIDIA NIM at https://integrate.api.nvidia.com/v1). model overrides the
// default gpt-5-mini. jsonObject selects response_format:{type:"json_object"}
// for endpoints that don't support strict json_schema well (NVIDIA's llama
// models: strict schema is slow (~29s) and yields degenerate values, so the
// schema shape is instead described in the prompt and enforced by parsing).
func NewOpenAIProvider(apiKey, baseURL, model string, jsonObject bool) OpenAIProvider {
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	if model == "" {
		model = modelGPT5Mini
	}
	return OpenAIProvider{client: openai.NewClient(opts...), model: model, jsonObject: jsonObject}
}

func modelDefault(p OpenAIProvider) string { return p.model }
```
Replace the hardcoded `modelGPT5Mini` usages in `IdentifyText`/`IdentifyPhoto`/`Decompose` with `p.model`.

Add `buildParams` (pure — no network) and use it inside `generateJSON`:
```go
// jsonObjectSchemaHint renders a compact description of a JSON schema's shape
// for embedding in a system prompt when json_object mode can't enforce the
// schema server-side. It lists the required top-level key and item fields.
func jsonObjectSchemaHint(schema map[string]any) string {
	b, _ := json.Marshal(schema)
	return "Respond with a single JSON object matching exactly this JSON Schema " +
		"(no extra keys, no nutrition/calorie/macro numbers): " + string(b)
}

func (p OpenAIProvider) buildParams(
	model, systemPrompt string,
	userParts []openai.ChatCompletionContentPartUnionParam,
	schemaName string,
	schema map[string]any,
) openai.ChatCompletionNewParams {
	sys := systemPrompt
	var rf openai.ChatCompletionNewParamsResponseFormatUnion
	if p.jsonObject {
		sys = systemPrompt + " " + jsonObjectSchemaHint(schema)
		rf = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONObject: &shared.ResponseFormatJSONObjectParam{},
		}
	} else {
		rf = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &shared.ResponseFormatJSONSchemaParam{
				JSONSchema: shared.ResponseFormatJSONSchemaJSONSchemaParam{
					Name:   schemaName,
					Strict: openai.Bool(true),
					Schema: schema,
				},
			},
		}
	}
	return openai.ChatCompletionNewParams{
		Model: model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(sys),
			openai.UserMessage(userParts),
		},
		ResponseFormat: rf,
	}
}
```
Then in `generateJSON`, replace the inline `params := openai.ChatCompletionNewParams{...}` block with:
```go
	params := p.buildParams(model, systemPrompt, userParts, schemaName, schema)
```
> Confirm `shared.ResponseFormatJSONObjectParam` is the correct type name in installed openai-go v1.12.0 via `go doc`. If json_object is constructed differently, adapt (the behavior — `OfJSONObject` set, schema hint in prompt — is what matters).

The invariant still holds in compat mode: `guessJSONSchema`/`ingredientJSONSchema` have no nutrition field, `parseGuesses`/`parseIngredients` decode only identity/portion/confidence, and any stray key the model emits is dropped at parse. Add/confirm a test asserting a compat-mode response with an injected `"kcal"` key is dropped by `parseGuesses` (the existing gemini/openai parse-drop tests already cover this shape — reuse if present).

- [ ] **Step 5: Run adapter tests**

Run: `cd api && go test -race -p 1 ./internal/ai/providers/ -v`
Expected: PASS (all no-network).

- [ ] **Step 6: NVIDIA live smoke (build-tagged, off by default)**

Create `api/internal/ai/providers/smoke_test.go`:
```go
//go:build smoke

package providers

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestNVIDIAFallbackSmoke exercises the OpenAI-compatible adapter against the
// live NVIDIA NIM endpoint. Run with:
//   OPENAI_API_KEY=$NVIDIA_API_KEY \
//   OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
//   go test -tags smoke ./internal/ai/providers/ -run TestNVIDIAFallbackSmoke -v
// NVIDIA cold starts are slow; allow a generous timeout.
func TestNVIDIAFallbackSmoke(t *testing.T) {
	key := os.Getenv("OPENAI_API_KEY")
	base := os.Getenv("OPENAI_BASE_URL")
	if key == "" || base == "" {
		t.Skip("OPENAI_API_KEY/OPENAI_BASE_URL not set — skipping NVIDIA smoke")
	}
	p := NewOpenAIProvider(key, base, "meta/llama-3.3-70b-instruct", true)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	guesses, usage, err := p.IdentifyText(ctx, "two eggs and toast")
	if err != nil {
		t.Fatalf("IdentifyText: %v", err)
	}
	if len(guesses) == 0 {
		t.Fatal("expected at least one guess")
	}
	for _, g := range guesses {
		if g.Food == "" {
			t.Fatalf("empty food in guess: %+v", g)
		}
	}
	t.Logf("guesses=%+v usage=%+v", guesses, usage)
}
```

- [ ] **Step 7: Commit (code only — smoke is controller-run)**

Run: `cd api && gofmt -l . && go vet ./internal/config/ ./internal/ai/providers/ && go test -race -p 1 ./internal/config/ ./internal/ai/providers/`
```bash
git add api/internal/config api/internal/ai/providers
git commit -m "feat(api): configurable openai-compatible fallback with json_object compat path"
```

> **Controller (after subagent):** update `api/.env` to add `OPENAI_API_KEY=<nvapi key>`, `OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`, `OPENAI_MODEL=meta/llama-3.3-70b-instruct`, `OPENAI_JSON_OBJECT=true` (keep `NVIDIA_API_KEY` for reference). Then run the smoke: `cd api && set -a && . ./.env && set +a && go test -tags smoke ./internal/ai/providers/ -run TestNVIDIAFallbackSmoke -v` and confirm live guesses.

---

## Task 2b: Router — dedicated (generous) fallback latency budget

> **Inserted after the Task 2 live smoke.** The NVIDIA fallback identified foods correctly but took ~75s on a cold start (seconds even when warm). The router's `withFallback` currently bounds the FALLBACK call with the SAME budget as primary (text 1.5s / photo 3s), so the fallback would be killed at 1.5s and could essentially never serve — defeating the whole point of wiring it. Give the fallback its own generous budget.

**Files:**
- Modify: `api/internal/ai/router.go`, `api/internal/ai/router_test.go`
- Modify: `api/internal/ai/provider_test.go` (add a `delay` field to the shared `stubProvider`)

**Interfaces:**
- Produces: `Router` gains a `FallbackBudget time.Duration` override field (zero ⇒ default `fallbackBudget` const). `withFallback` takes a separate fallback budget for the fallback call. Primary budgets (`textBudget`/`photoBudget`) are unchanged.

- [ ] **Step 1: Add a `delay` field to the shared stub (test fixture)**

In `api/internal/ai/provider_test.go`, add to `stubProvider`:
```go
	// delay, when > 0 and block is false, makes every method sleep for delay
	// (respecting ctx) before returning its configured result — simulates a
	// slow-but-succeeding provider (e.g. the NVIDIA fallback's cold start).
	delay time.Duration
```
and at the top of each of the four methods (IdentifyText/IdentifyPhoto/Decompose/Embed), after `s.calls++` and before the `block` check, add:
```go
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, Usage{}, ctx.Err() // for Embed: return nil, Usage{}, ctx.Err()
		}
	}
```
(Return types differ per method — match each method's zero return: `nil, Usage{}, ctx.Err()` works for all four since the first return is a nilable slice.) Add `"time"` to the test imports if not present.

- [ ] **Step 2: Failing test — fallback survives past the primary budget**

Add to `api/internal/ai/router_test.go`:
```go
// TestRouter_FallbackGetsGenerousBudget verifies the fallback is NOT capped at
// the primary's tight latency budget: primary times out fast (20ms), and the
// fallback takes longer than that budget (60ms) but well under its own
// FallbackBudget (500ms), so it must still succeed. Before the dedicated
// fallback budget, the fallback shared the 20ms cap and would be cancelled.
func TestRouter_FallbackGetsGenerousBudget(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		delay:      60 * time.Millisecond,
		guesses:    []Guess{{Food: "slow-but-served"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond, FallbackBudget: 500 * time.Millisecond}

	guesses, usage, err := r.IdentifyText(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "slow-but-served"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}
```
Run: `cd api && go test ./internal/ai/ -run TestRouter_FallbackGetsGenerousBudget` → FAIL (fallback cancelled at 20ms; `FallbackBudget` field undefined).

- [ ] **Step 3: Implement the dedicated fallback budget in `router.go`**

Add the const alongside the existing budgets:
```go
	// fallbackBudget is deliberately generous: the fallback provider only runs
	// after the primary has already failed or timed out, so latency there is a
	// last-resort cost we accept rather than fail the resolve. It also absorbs
	// slow cold starts on free-tier fallback endpoints (NVIDIA NIM cold start
	// was measured at ~75s). Bounded only so a truly hung fallback can't pin a
	// request forever; the request's own context still applies on top.
	fallbackBudget = 90 * time.Second
```
Add the override field to `Router` (next to `PhotoBudget`/`TextBudget`):
```go
	// FallbackBudget overrides the default fallbackBudget when non-zero. Tests
	// use it to keep the fallback-latency path fast; production leaves it unset.
	FallbackBudget time.Duration
```
Add the accessor:
```go
func (r *Router) fallbackBudgetOrDefault() time.Duration {
	if r.FallbackBudget > 0 {
		return r.FallbackBudget
	}
	return fallbackBudget
}
```
Change `withFallback` to take a separate fallback budget and use it for the fallback context:
```go
func withFallback[T any](ctx context.Context, budget, fbBudget time.Duration, primary, fallback func(context.Context) (T, Usage, error)) (T, Usage, error) {
	primaryCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	result, usage, err := primary(primaryCtx)
	if err == nil && primaryCtx.Err() == nil {
		return result, usage, nil
	}

	fallbackCtx, fallbackCancel := context.WithTimeout(ctx, fbBudget)
	defer fallbackCancel()
	return fallback(fallbackCtx)
}
```
Update all four call sites (IdentifyText/IdentifyPhoto/Decompose/Embed) to pass `r.fallbackBudgetOrDefault()` as the new second budget arg, e.g.:
```go
func (r *Router) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyText(c, phrase) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyText(c, phrase) },
	)
}
```
Run: `cd api && go test -race -p 1 ./internal/ai/ -v` → PASS (new test + all existing router tests still green — existing latency test leaves `FallbackBudget` unset, so its immediate-return fallback stub is unaffected).

- [ ] **Step 4: gofmt/vet + commit**

Run: `cd api && gofmt -l . && go vet ./internal/ai/ && go test -race -p 1 ./internal/ai/`
```bash
git add api/internal/ai/router.go api/internal/ai/router_test.go api/internal/ai/provider_test.go
git commit -m "fix(api): give ai router fallback its own generous latency budget"
```

---

## Task 3: Resolve API handler + routes (text / photo / barcode)

**Files:**
- Create: `api/internal/resolve/handler.go`, `api/internal/resolve/handler_test.go`
- Modify: `api/internal/server/router.go`, `api/internal/server/router_test.go`

**Interfaces:**
- Consumes: `user.IDFromContext`, `ai.Resolution`, `nutrition.FoodItem`, `httpx`.
- Produces:
  - `resolve.Handler` with `ResolveText(c)`, `ResolvePhoto(c)`, `ResolveBarcode(c)`.
  - Small ports for testability:
    ```go
    type TextPhotoResolver interface {
        ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (ai.Resolution, error)
        ResolvePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (ai.Resolution, error)
    }
    type BarcodeResolver func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error)
    ```
    `ai.Resolver` (value) satisfies `TextPhotoResolver`. `BarcodeResolver` is bound in `main` to `func(ctx, code){ return foods.ResolveBarcode(ctx, off, code) }`.
  - `resolve.NewHandler(tp TextPhotoResolver, bc BarcodeResolver) Handler`.
  - `server.Deps` gains `Resolver *resolve.Handler` (nil ⇒ resolve routes not mounted).

- [ ] **Step 1: Handler tests first (no network)**

Create `api/internal/resolve/handler_test.go` with a `stubTP` implementing `TextPhotoResolver` and a stub `BarcodeResolver`, wired through a minimal gin engine that pre-sets the user id in context (mimicking `user.ResolveMiddleware`). Cases:
  - `POST /resolve/text` with `{"phrase":"chicken"}` → 200, body `{"data": {...tier...candidates...}}`.
  - `POST /resolve/text` with `{"phrase":""}` (or missing) → 400 `invalid_input`.
  - `POST /resolve/text` when stub returns an infra error → 500 generic (via `httpx.RespondServiceError`).
  - `POST /resolve/photo` multipart with a small `file` part → 200; stub receives bytes+mime.
  - `POST /resolve/photo` with no file → 400.
  - `POST /resolve/photo` with a file exceeding the size cap → 413 `payload_too_large`.
  - `POST /resolve/barcode` `{"barcode":"123"}`, stub returns a found `FoodItem` → 200 with a single candidate, `tier:"auto"`, `provenance` from the item, `kcal == KcalPer100g` (100g default).
  - `POST /resolve/barcode` stub returns `(nil,false,nil)` (unknown) → 200 `tier:"follow_up"`, empty candidates, `provenance:"barcode"`, a follow-up question (no fabricated row).

Example skeleton:
```go
package resolve

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type stubTP struct {
	text  ai.Resolution
	photo ai.Resolution
	err   error
	gotMime string
}

func (s *stubTP) ResolveText(ctx context.Context, uid uuid.UUID, phrase string) (ai.Resolution, error) {
	return s.text, s.err
}
func (s *stubTP) ResolvePhoto(ctx context.Context, uid uuid.UUID, img []byte, mime string) (ai.Resolution, error) {
	s.gotMime = mime
	return s.photo, s.err
}

func newEngine(h Handler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() }) // matches user.ResolveMiddleware key
	g := r.Group("/resolve")
	g.POST("/text", h.ResolveText)
	g.POST("/photo", h.ResolvePhoto)
	g.POST("/barcode", h.ResolveBarcode)
	return r
}
// ... table cases as above; build multipart bodies with multipart.NewWriter.
```
> Confirm the exact context key `user.IDFromContext` reads (`"user_id"`) by reading `internal/user/middleware.go` — use the same key in the test middleware so `IDFromContext` succeeds.

Run: `cd api && go test ./internal/resolve/` → FAIL (package/handler undefined).

- [ ] **Step 2: Implement `handler.go`**

Create `api/internal/resolve/handler.go`:
```go
// Package resolve exposes the AI food-resolution engine over HTTP. It is a
// thin transport layer: all resolution logic lives in package ai and the
// nutrition index; this package only parses requests, enforces limits, calls
// the injected resolver, and formats responses. It never introduces a
// nutrition number — every kcal/macro in a response originates from a
// nutrition.FoodItem row inside the engine.
package resolve

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/user"
)

// maxPhotoBytes caps an uploaded resolve photo. Vision models reject huge
// inputs anyway; this protects the server from oversized uploads.
const maxPhotoBytes = 8 << 20 // 8 MiB

// barcodeUnknownQuestion is returned (with no candidates, no fabricated row)
// when a scanned barcode matches nothing locally or on OpenFoodFacts.
const barcodeUnknownQuestion = "Barcode not recognized — search and log manually."

// barcodeDefaultGrams is the portion assumed for a barcode hit, which carries
// no portion signal. Nutrition is still row-sourced: kcal = KcalPer100g * 1.
const barcodeDefaultGrams = 100.0

type TextPhotoResolver interface {
	ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (ai.Resolution, error)
	ResolvePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (ai.Resolution, error)
}

type BarcodeResolver func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error)

type Handler struct {
	tp TextPhotoResolver
	bc BarcodeResolver
}

func NewHandler(tp TextPhotoResolver, bc BarcodeResolver) Handler {
	return Handler{tp: tp, bc: bc}
}

type textRequest struct {
	Phrase string `json:"phrase"`
}

func (h Handler) ResolveText(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req textRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Phrase) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "phrase must be at least 2 characters")
		return
	}
	res, err := h.tp.ResolveText(c.Request.Context(), uid, req.Phrase)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res)
}

func (h Handler) ResolvePhoto(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "file is required")
		return
	}
	if fileHeader.Size > maxPhotoBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	defer f.Close()
	buf := make([]byte, 0, fileHeader.Size)
	tmp := make([]byte, 32<<10)
	for {
		n, rerr := f.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if rerr != nil {
			break
		}
		if len(buf) > maxPhotoBytes {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
			return
		}
	}
	mime := fileHeader.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(buf)
	}
	res, err := h.tp.ResolvePhoto(c.Request.Context(), uid, buf, mime)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res)
}

type barcodeRequest struct {
	Barcode string `json:"barcode"`
}

func (h Handler) ResolveBarcode(c *gin.Context) {
	if _, ok := user.IDFromContext(c); !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req barcodeRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Barcode == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "barcode is required")
		return
	}
	item, found, err := h.bc(c.Request.Context(), req.Barcode)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	if !found {
		httpx.OK(c, ai.Resolution{
			Tier:             ai.TierFollowUp,
			FollowUpQuestion: barcodeUnknownQuestion,
			Provenance:       "barcode",
		})
		return
	}
	// Nutrition is row-sourced: kcal = KcalPer100g * (grams/100).
	kcal := item.KcalPer100g * barcodeDefaultGrams / 100
	httpx.OK(c, ai.Resolution{
		Candidates: []ai.ResolvedCandidate{{
			Item:         *item,
			PortionGrams: barcodeDefaultGrams,
			Kcal:         kcal,
			MatchScore:   1.0,
			MatchTier:    nutrition.MatchAlias, // exact barcode == exact match
		}},
		Tier:       ai.TierAuto,
		Provenance: item.Provenance,
	})
}
```
> Confirm `nutrition.MatchAlias` (or the equivalent exact-match tier constant) exists; if the exact-match constant is named differently, use that. If none fits a barcode, use the string `"barcode"`.

- [ ] **Step 3: Run handler tests → PASS**

Run: `cd api && go test -race -p 1 ./internal/resolve/ -v` → PASS.

- [ ] **Step 4: Register routes in the router (test first)**

There is no existing authed-router test harness (the v1 group needs `DB != nil && Verifier != nil`, and route *registration* touches neither the DB nor the verifier — both are only used per-request). So verify registration by inspecting `gin.Engine.Routes()` with dummy non-nil deps, not by sending authed requests. Add to `api/internal/server/router_test.go`:
```go
type stubVerifier struct{}

func (stubVerifier) Verify(ctx context.Context, idToken string) (auth.Claims, error) {
	return auth.Claims{}, nil
}

func hasRoute(routes gin.RoutesInfo, method, path string) bool {
	for _, r := range routes {
		if r.Method == method && r.Path == path {
			return true
		}
	}
	return false
}

func TestResolveRoutesRegisteredWhenResolverSet(t *testing.T) {
	h := resolve.NewHandler(nil, nil) // never invoked — we only inspect registration
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, Resolver: &h})
	routes := r.Routes()
	for _, p := range []string{"/v1/resolve/text", "/v1/resolve/photo", "/v1/resolve/barcode"} {
		if !hasRoute(routes, "POST", p) {
			t.Errorf("expected POST %s to be registered", p)
		}
	}
}

func TestResolveRoutesAbsentWhenResolverNil(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}}) // Resolver nil
	if hasRoute(r.Routes(), "POST", "/v1/resolve/text") {
		t.Error("resolve routes must not be registered when Resolver is nil")
	}
}
```
Add imports `"context"`, `"gorm.io/gorm"`, and the `auth` + `resolve` packages to the test. Run → FAIL (`Deps.Resolver` field + routes absent). `resolve.NewHandler(nil, nil)` is safe here because the handler is never invoked — the test only reads the route table.

- [ ] **Step 5: Wire routes in `router.go`**

In `api/internal/server/router.go`, add to `Deps`:
```go
	Resolver *resolve.Handler
```
Import `"github.com/tesserix/kora/api/internal/resolve"`. Inside the `if deps.DB != nil && deps.Verifier != nil {` block, after the existing routes and before `NoRoute`, add:
```go
		if deps.Resolver != nil {
			v1.POST("/resolve/text", deps.Resolver.ResolveText)
			v1.POST("/resolve/photo", deps.Resolver.ResolvePhoto)
			v1.POST("/resolve/barcode", deps.Resolver.ResolveBarcode)
		}
```
Run: `cd api && go test -race -p 1 ./internal/server/ -v` → PASS.

- [ ] **Step 6: gofmt/vet + commit**

Run: `cd api && gofmt -l . && go vet ./internal/resolve/ ./internal/server/ && go test -race -p 1 ./internal/resolve/ ./internal/server/`
```bash
git add api/internal/resolve api/internal/server/router.go api/internal/server/router_test.go
git commit -m "feat(api): mount /v1/resolve/{text,photo,barcode} endpoints"
```

---

## Task 4: Compose the AI engine in main.go (wiring + live smoke)

**Files:**
- Modify: `api/cmd/api/main.go`

**Interfaces:**
- Consumes: `config.Config` (Gemini/OpenAI keys + base URL/model/json-object), `providers.NewGeminiProvider`, `providers.NewOpenAIProvider`, `ai.Router`, `ai.NewResolver`, `ai.NewRedisCache`/`ai.NoCache`, `billing.NewMeter`, `nutrition.NewRepository`, `nutrition.NewHTTPOFFClient`, `resolve.NewHandler`.
- Produces: a `*resolve.Handler` (or nil when Gemini key absent) passed into `server.Deps.Resolver`.

- [ ] **Step 1: Build the engine and inject it**

In `api/cmd/api/main.go`, after `db, err := database.Connect(...)` and before building `srv`, add a helper that composes the resolve handler:
```go
	resolveHandler := buildResolveHandler(context.Background(), cfg, db, logger)

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: server.NewRouter(server.Deps{DB: db, Verifier: verifier, Resolver: resolveHandler}),
	}
```
Add the helper at the bottom of the file:
```go
// buildResolveHandler composes the AI resolution engine from config. It
// returns nil (resolve endpoints stay unmounted) when no Gemini key is set —
// the rest of the API runs unchanged. The OpenAI-compatible fallback is
// optional: with no OpenAI key, Gemini serves alone (no Router).
func buildResolveHandler(ctx context.Context, cfg config.Config, db *gorm.DB, logger *slog.Logger) *resolve.Handler {
	if cfg.GeminiAPIKey == "" {
		logger.Info("resolve engine disabled (no GEMINI_API_KEY)")
		return nil
	}
	gemini, err := providers.NewGeminiProvider(ctx, cfg.GeminiAPIKey)
	if err != nil {
		logger.Error("gemini provider init failed — resolve engine disabled", "err", err)
		return nil
	}

	var provider ai.Provider = gemini
	if cfg.OpenAIAPIKey != "" {
		fallback := providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject)
		provider = &ai.Router{Primary: gemini, Fallback: fallback}
		logger.Info("resolve engine: gemini primary + openai-compatible fallback", "model", cfg.OpenAIModel, "base_url", cfg.OpenAIBaseURL)
	} else {
		logger.Info("resolve engine: gemini only (no fallback key)")
	}

	var cache ai.Cache = ai.NoCache{}
	if opt, err := redis.ParseURL(cfg.RedisURL); err == nil {
		client := redis.NewClient(opt)
		if pingErr := client.Ping(ctx).Err(); pingErr == nil {
			cache = ai.NewRedisCache(client, 24*time.Hour)
			logger.Info("resolve engine: redis cache enabled")
		} else {
			logger.Info("resolve engine: redis unreachable, cache disabled", "err", pingErr)
		}
	}

	foods := nutrition.NewRepository(db)
	meter := billing.NewMeter(db)
	resolver := ai.NewResolver(provider, foods, cache, meter)
	off := nutrition.NewHTTPOFFClient()

	h := resolve.NewHandler(resolver, func(c context.Context, code string) (*nutrition.FoodItem, bool, error) {
		return foods.ResolveBarcode(c, off, code)
	})
	return &h
}
```
Add imports: `"time"`, `"gorm.io/gorm"`, `"github.com/redis/go-redis/v9"`, and the `ai`, `billing`, `nutrition`, `providers`, `resolve` packages.
> `ai.NewResolver` returns a value `Resolver` that satisfies `resolve.TextPhotoResolver` — passing it directly is correct. Confirm `redis.ParseURL`/`NewClient` names against the installed go-redis/v9 (`go doc github.com/redis/go-redis/v9`).

- [ ] **Step 2: Build the whole module**

Run: `cd api && go build ./... && go vet ./cmd/api/`
Expected: clean build. (No unit test for `main` wiring — it is composition; correctness is verified by the live smoke below.)

- [ ] **Step 3: Commit**

Run: `cd api && gofmt -l .`
```bash
git add api/cmd/api/main.go
git commit -m "feat(api): compose ai resolution engine in main and mount resolve routes"
```

> **Controller (after subagent, needs live keys + running server):**
> 1. Ensure `api/.env` has `GEMINI_API_KEY` and the OpenAI-compat fallback vars (from Task 2 controller step).
> 2. Start the server: `cd api && set -a && . ./.env && set +a && go run ./cmd/api &` (or a dedicated terminal). It migrates + listens on `:8080`.
> 3. Mint a dev Firebase ID token (reuse the mechanism the mobile/dev harness uses) OR temporarily point at a decode-only verifier per the dev path; then curl:
>    - `curl -s -X POST localhost:8080/v1/resolve/text -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"phrase":"two eggs and toast"}' | jq`
>    - `curl -s -X POST localhost:8080/v1/resolve/photo -H "Authorization: Bearer $TOK" -F file=@some_meal.jpg | jq`
>    - `curl -s -X POST localhost:8080/v1/resolve/barcode -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"barcode":"3017620422003"}' | jq`
>    Confirm: candidates carry `tier`, `provenance`, row-sourced `kcal`; no fabricated rows on unknown barcode. Verify a metering row landed: `psql "$DATABASE_URL" -c "select provider,model,call_type,cost_usd_est from ai_usage_events order by created_at desc limit 5;"`.

---

## Task 5: Full log-edit endpoint + correction alias loop

**Files:**
- Create: `api/internal/nutrition/alias.go`, `api/internal/nutrition/alias_test.go`
- Modify: `api/internal/foodlog/repository.go`, `api/internal/foodlog/service.go`, `api/internal/foodlog/handler.go`, plus tests
- Modify: `api/internal/server/router.go`

**Interfaces:**
- Produces:
  - `nutrition.Repository.AddAlias(ctx context.Context, alias string, foodItemID uuid.UUID) error` — idempotent guarded insert on **lower+trim** (no new migration; the `lower(alias)` index is non-unique so use check-then-insert). Empty/blank alias is a no-op (nil).
  - `foodlog.Service.EditLog(ctx, userID, logID uuid.UUID, req EditRequest) (FoodLog, error)` — edits meal slot / logged-at / food / grams; recomputes nutrition from the row when food or grams change; records a correction alias when the food changed and `req.CorrectionPhrase` is non-empty.
  - `foodlog.Repository.Update(ctx, log FoodLog) (FoodLog, error)` — user-scoped update by `id AND user_id`.
  - `PATCH /v1/logs/:id`.

- [ ] **Step 1: `AddAlias` (test first)**

Create `api/internal/nutrition/alias_test.go` (DB integration; SKIP if no DB — mirror the skip pattern in `resolve_test.go`):
```go
package nutrition

import (
	"context"
	"strings"
	"testing"
)

func TestAddAliasLowerTrimIdempotentAndResolvable(t *testing.T) {
	db := testDB(t) // existing helper used by other nutrition DB tests
	repo := NewRepository(db)
	ctx := context.Background()

	item := seedFoodItem(t, db, "Rolled Oats") // existing seed helper; returns FoodItem
	t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE lower(alias) = ?", "brekkie") })

	// Mixed-case + surrounding space must be stored lower+trim.
	if err := repo.AddAlias(ctx, "  Brekkie  ", item.ID); err != nil {
		t.Fatal(err)
	}
	// Idempotent: second call for the same (alias,item) inserts nothing extra.
	if err := repo.AddAlias(ctx, "brekkie", item.ID); err != nil {
		t.Fatal(err)
	}
	var n int64
	db.Raw("SELECT count(*) FROM food_aliases WHERE lower(alias) = ? AND food_item_id = ?", "brekkie", item.ID).Scan(&n)
	if n != 1 {
		t.Fatalf("alias rows = %d, want 1 (idempotent)", n)
	}
	// Resolvable via the alias tier (score 1.0).
	cands, err := repo.Resolve(ctx, "Brekkie", nil, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) == 0 || cands[0].Item.ID != item.ID || cands[0].MatchTier != MatchAlias {
		t.Fatalf("alias not resolved: %+v", cands)
	}
	// Blank alias is a safe no-op.
	if err := repo.AddAlias(ctx, "   ", item.ID); err != nil {
		t.Fatalf("blank alias should be a no-op, got %v", err)
	}
	_ = strings.TrimSpace
}
```
> Use whatever DB/seed helpers the nutrition test files already define (read `resolve_test.go`/`barcode_test.go` first). Do not invent parallel helpers.

Run: `cd api && go test ./internal/nutrition/ -run TestAddAlias` → FAIL (`AddAlias` undefined).

- [ ] **Step 2: Implement `AddAlias`**

Create `api/internal/nutrition/alias.go`:
```go
package nutrition

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// AddAlias records a correction alias mapping a user phrase to a food item.
// The alias is stored lower+trim to match idx_food_aliases_alias ON
// food_aliases (lower(alias)) and the alias tier in Resolve — NOT Normalize,
// which would strip punctuation/singularize and cause future lookups to miss.
// It is idempotent per (alias, food_item_id): a duplicate insert is skipped.
// A blank alias is a no-op.
func (r Repository) AddAlias(ctx context.Context, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" {
		return nil
	}
	var n int64
	if err := r.db.WithContext(ctx).
		Raw("SELECT count(*) FROM food_aliases WHERE lower(alias) = ? AND food_item_id = ?", key, foodItemID).
		Scan(&n).Error; err != nil {
		return fmt.Errorf("nutrition: add alias check: %w", err)
	}
	if n > 0 {
		return nil
	}
	if err := r.db.WithContext(ctx).
		Exec("INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", key, foodItemID).Error; err != nil {
		return fmt.Errorf("nutrition: add alias insert: %w", err)
	}
	return nil
}
```
Run: `cd api && go test -race -p 1 ./internal/nutrition/ -run TestAddAlias` → PASS (or SKIP).

- [ ] **Step 3: `foodlog.Repository.Update` (test first)**

In `api/internal/foodlog/repository_test.go` (or the existing foodlog DB test file), add a test asserting `Update` changes fields for the owner and is a no-op / not-found for a different user (tenant isolation). Follow the file's existing skip-if-no-DB + seed patterns. Run → FAIL.

Implement in `api/internal/foodlog/repository.go`:
```go
// Update persists changes to an existing log, scoped to its owner. It updates
// by (id AND user_id) so a user can never edit another user's log; if no row
// matches, it returns gorm.ErrRecordNotFound wrapped.
func (r Repository) Update(ctx context.Context, log FoodLog) (FoodLog, error) {
	res := r.db.WithContext(ctx).
		Model(&FoodLog{}).
		Where("id = ? AND user_id = ?", log.ID, log.UserID).
		Updates(map[string]any{
			"food_item_id":   log.FoodItemID,
			"logged_at":      log.LoggedAt,
			"meal_slot":      log.MealSlot,
			"description":    log.Description,
			"quantity_grams": log.QuantityGrams,
			"kcal":           log.Kcal,
			"protein_g":      log.ProteinG,
			"carbs_g":        log.CarbsG,
			"fat_g":          log.FatG,
			"fiber_g":        log.FiberG,
			"provenance":     log.Provenance,
		})
	if res.Error != nil {
		return FoodLog{}, fmt.Errorf("foodlog: update: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return FoodLog{}, fmt.Errorf("foodlog: update: %w", gorm.ErrRecordNotFound)
	}
	return r.GetByID(ctx, log.UserID, log.ID)
}
```
> Add `"gorm.io/gorm"` to the repository imports if not present. `Updates(map)` is used (not struct) so zero-values like an empty meal slot are written intentionally by the caller, never silently skipped.

Run → PASS (or SKIP).

- [ ] **Step 4: `foodlog.Service.EditLog` (test first)**

Add to the foodlog service test (integration; SKIP if no DB) cases:
  - grams change only → kcal/macros recomputed from the SAME food row (`newKcal == item.KcalPer100g * newGrams/100`), description unchanged.
  - food change + `CorrectionPhrase:"my brekkie"` → nutrition recomputed from the NEW row; `nutrition.Repository.AddAlias` recorded the phrase→new item (assert `foods.Resolve("my brekkie")` top is the new item).
  - food change with empty `CorrectionPhrase` → no alias recorded (phrase not resolvable).
  - invalid meal slot → `httpx.ValidationError`.

Run → FAIL.

Implement in `api/internal/foodlog/service.go`:
```go
// EditRequest carries a partial edit to an existing log. Nil/zero fields mean
// "leave unchanged", except MealSlot which, when non-empty, is validated.
// CorrectionPhrase is the original user text that resolved to the WRONG food;
// when the food is changed and this is set, it is recorded as an alias
// (lower+trim) mapping the phrase to the corrected item so future resolves hit
// the alias tier. Nutrition is NEVER taken from the request — it is always
// recomputed from the (possibly new) food row.
type EditRequest struct {
	FoodItemID       *uuid.UUID `json:"food_item_id"`
	MealSlot         string     `json:"meal_slot"`
	QuantityGrams    *float64   `json:"quantity_grams"`
	LoggedAt         *time.Time `json:"logged_at"`
	CorrectionPhrase string     `json:"correction_phrase"`
}

func (s Service) EditLog(ctx context.Context, userID, logID uuid.UUID, req EditRequest) (FoodLog, error) {
	current, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: edit: load: %w", err)
	}

	if req.MealSlot != "" {
		if !validMealSlots[req.MealSlot] {
			return FoodLog{}, httpx.ValidationError{Message: "invalid meal_slot"}
		}
		current.MealSlot = req.MealSlot
	}
	if req.LoggedAt != nil {
		current.LoggedAt = *req.LoggedAt
	}

	foodChanged := req.FoodItemID != nil && (current.FoodItemID == nil || *req.FoodItemID != *current.FoodItemID)
	gramsChanged := req.QuantityGrams != nil && *req.QuantityGrams != current.QuantityGrams

	if req.QuantityGrams != nil {
		if *req.QuantityGrams <= 0 {
			return FoodLog{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
		}
		current.QuantityGrams = *req.QuantityGrams
	}
	if req.FoodItemID != nil {
		current.FoodItemID = req.FoodItemID
	}

	// Recompute nutrition from the row whenever food or grams changed.
	if foodChanged || gramsChanged {
		if current.FoodItemID == nil {
			return FoodLog{}, httpx.ValidationError{Message: "food_item_id required to recompute nutrition"}
		}
		item, err := s.foods.GetByID(ctx, *current.FoodItemID)
		if err != nil {
			return FoodLog{}, fmt.Errorf("foodlog: edit: resolve food: %w", err)
		}
		f := current.QuantityGrams / 100.0
		current.Description = item.Name
		current.Kcal = item.KcalPer100g * f
		current.ProteinG = item.ProteinPer100g * f
		current.CarbsG = item.CarbsPer100g * f
		current.FatG = item.FatPer100g * f
		current.FiberG = item.FiberPer100g * f
		current.Provenance = item.Provenance
	}

	updated, err := s.logs.Update(ctx, current)
	if err != nil {
		return FoodLog{}, err
	}

	// Correction alias: record the original phrase -> corrected item so future
	// resolves auto-hit it. Best-effort — an alias write must not fail the edit.
	if foodChanged && req.CorrectionPhrase != "" && current.FoodItemID != nil {
		if aerr := s.foods.AddAlias(ctx, req.CorrectionPhrase, *current.FoodItemID); aerr != nil {
			// Log-and-continue: the edit already succeeded.
			_ = aerr
		}
	}
	return updated, nil
}
```
Run → PASS (or SKIP).

- [ ] **Step 5: Handler `Update` + PATCH route (test first)**

Add a foodlog handler test (httptest + gin, matching the existing handler-test style with a pre-set `user_id`) for `PATCH /logs/:id`: 200 on a valid grams edit (asserts recomputed kcal in the response), 400 on invalid meal slot, 404 on unknown/other-user log, 400 on a bad `:id`. Run → FAIL.

Implement in `api/internal/foodlog/handler.go`:
```go
func (h Handler) Update(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	logID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid log id")
		return
	}
	var req EditRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	updated, err := h.svc.EditLog(c.Request.Context(), userID, logID, req)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			httpx.Error(c, http.StatusNotFound, "not_found", "log not found")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, updated)
}
```
> Match the handler's existing field names for the service (`h.svc`) and error imports; add `"errors"` and `"gorm.io/gorm"` if missing. Confirm `resolveUser` signature by reading `handler.go`.

Register in `api/internal/server/router.go`, alongside the other log routes:
```go
		v1.PATCH("/logs/:id", logHandler.Update)
```
Run: `cd api && go test -race -p 1 ./internal/foodlog/ ./internal/server/` → PASS.

- [ ] **Step 6: gofmt/vet + commit**

Run: `cd api && gofmt -l . && go vet ./internal/nutrition/ ./internal/foodlog/ ./internal/server/ && go test -race -p 1 ./internal/nutrition/ ./internal/foodlog/ ./internal/server/`
```bash
git add api/internal/nutrition/alias.go api/internal/nutrition/alias_test.go api/internal/foodlog api/internal/server/router.go api/internal/server/router_test.go
git commit -m "feat(api): full log-edit endpoint with correction alias loop"
```

---

## Task 6: Eval harness scaffold (blocked on user golden dataset)

**Files:**
- Create: `api/internal/ai/eval_test.go` (`//go:build eval`)
- Create: `api/testdata/eval/README.md`, `api/testdata/eval/chat.sample.jsonl`, `api/testdata/eval/.gitignore`

**Interfaces:**
- Produces: an `eval`-tagged Go test that, given a golden dataset, runs the live Resolver and scores: chat top-1 id accuracy ≥ 90%, photo top-1 id accuracy ≥ 80%, resolved-entry correctness ≥ 90%, median kcal error ≤ 20%, and zero hallucinated rows. Provider under test is selectable (`KORA_EVAL_PROVIDER=gemini|fallback`) for A/B. The runner is exercisable against a tiny committed sample fixture; the REAL dataset is user-provided and gitignored.

- [ ] **Step 1: Dataset schema + sample fixture**

Create `api/testdata/eval/README.md`:
```markdown
# Kora resolution eval dataset

Golden dataset for the Phase 2 resolution engine. **User-provided** — the real
files here (except the committed `*.sample.*`) are gitignored.

## chat.jsonl (one JSON object per line)
{"phrase": "two eggs and toast", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `phrase`      — the text a user would type/speak.
- `expected_name` — substring expected in the top-1 resolved candidate's item name (case-insensitive).
- `expected_kcal`  — reference kcal for the stated `grams` (for the median-error metric).
- `grams`        — portion the reference kcal is stated for.

## photos/ + photos.jsonl
photos.jsonl: {"file": "photos/omelette.jpg", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `file` is relative to testdata/eval/.

## Thresholds (exit gate)
- chat top-1 id accuracy  >= 0.90
- photo top-1 id accuracy >= 0.80
- resolved-entry correctness (a confident candidate returned) >= 0.90
- median kcal error <= 0.20
- zero hallucinated rows (every candidate has a real food_items.id)
```
Create `api/testdata/eval/chat.sample.jsonl` (committed, tiny — matches seeded AFCD staples so the harness runs end-to-end without the real dataset):
```
{"phrase": "rolled oats", "expected_name": "oat", "expected_kcal": 379, "grams": 100}
{"phrase": "banana", "expected_name": "banana", "expected_kcal": 89, "grams": 100}
```
> Adjust the two sample lines to match actual seeded rows (`psql "$DATABASE_URL" -c "select name, kcal_per_100g from food_items order by name limit 40;"`) so the sample passes against the local index.

Create `api/testdata/eval/.gitignore`:
```
# Real golden dataset is user-provided and not committed.
*
!.gitignore
!README.md
!chat.sample.jsonl
```

- [ ] **Step 2: The eval runner**

Create `api/internal/ai/eval_test.go`:
```go
//go:build eval

// Eval harness for the resolution engine. NOT part of `go test` — run with:
//
//   set -a && . ./.env && set +a
//   KORA_EVAL=1 KORA_EVAL_PROVIDER=gemini \
//     go test -tags eval ./internal/ai/ -run TestEvalChat -v
//
// Point KORA_EVAL_DATASET at a dir of chat.jsonl/photos.jsonl (defaults to
// ../../testdata/eval using chat.sample.jsonl when chat.jsonl is absent).
// KORA_EVAL_PROVIDER=gemini|fallback selects the provider under test for A/B.
package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type chatCase struct {
	Phrase       string  `json:"phrase"`
	ExpectedName string  `json:"expected_name"`
	ExpectedKcal float64 `json:"expected_kcal"`
	Grams        float64 `json:"grams"`
}

func requireEval(t *testing.T) {
	if os.Getenv("KORA_EVAL") != "1" {
		t.Skip("set KORA_EVAL=1 to run the eval harness")
	}
}

func evalProvider(t *testing.T, cfg config.Config) Provider {
	ctx := context.Background()
	gemini, err := providers.NewGeminiProvider(ctx, cfg.GeminiAPIKey)
	if err != nil {
		t.Fatalf("gemini init: %v", err)
	}
	if os.Getenv("KORA_EVAL_PROVIDER") == "fallback" {
		if cfg.OpenAIAPIKey == "" {
			t.Skip("KORA_EVAL_PROVIDER=fallback but no OPENAI_API_KEY set")
		}
		return providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject)
	}
	return gemini
}

func loadChatCases(t *testing.T) []chatCase {
	dir := os.Getenv("KORA_EVAL_DATASET")
	if dir == "" {
		dir = filepath.Join("..", "..", "testdata", "eval")
	}
	path := filepath.Join(dir, "chat.jsonl")
	if _, err := os.Stat(path); err != nil {
		path = filepath.Join(dir, "chat.sample.jsonl")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open dataset: %v", err)
	}
	defer f.Close()
	var cases []chatCase
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c chatCase
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			t.Fatalf("bad dataset line %q: %v", line, err)
		}
		cases = append(cases, c)
	}
	return cases
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	n := len(xs)
	if n%2 == 1 {
		return xs[n/2]
	}
	return (xs[n/2-1] + xs[n/2]) / 2
}

func TestEvalChat(t *testing.T) {
	requireEval(t)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	foods := nutrition.NewRepository(db)
	resolver := NewResolver(evalProvider(t, cfg), foods, NoCache{}, unlimitedMeter{})

	cases := loadChatCases(t)
	if len(cases) == 0 {
		t.Skip("no chat cases in dataset")
	}

	var idHits, resolved, hallucinated int
	var kcalErrs []float64
	uid := uuid.New()
	ctx := context.Background()

	for _, c := range cases {
		res, err := resolver.ResolveText(ctx, uid, c.Phrase)
		if err != nil {
			t.Logf("resolve %q: %v", c.Phrase, err)
			continue
		}
		if len(res.Candidates) == 0 {
			continue
		}
		resolved++
		top := res.Candidates[0]
		if top.Item.ID == uuid.Nil {
			hallucinated++ // no real row backing the candidate
		}
		if strings.Contains(strings.ToLower(top.Item.Name), strings.ToLower(c.ExpectedName)) {
			idHits++
		}
		if c.ExpectedKcal > 0 {
			refKcal := c.ExpectedKcal
			gotKcal := top.Item.KcalPer100g * c.Grams / 100
			kcalErrs = append(kcalErrs, math.Abs(gotKcal-refKcal)/refKcal)
		}
	}

	n := float64(len(cases))
	idAcc := float64(idHits) / n
	resolvedRate := float64(resolved) / n
	medErr := median(kcalErrs)
	t.Logf("provider=%s chat: id_acc=%.2f resolved=%.2f median_kcal_err=%.2f hallucinated=%d (n=%d)",
		cfg.OpenAIModel, idAcc, resolvedRate, medErr, hallucinated, len(cases))

	if hallucinated != 0 {
		t.Errorf("hallucinated rows: %d (want 0)", hallucinated)
	}
	if idAcc < 0.90 {
		t.Errorf("chat top-1 id accuracy %.2f < 0.90", idAcc)
	}
	if resolvedRate < 0.90 {
		t.Errorf("resolved-entry correctness %.2f < 0.90", resolvedRate)
	}
	if len(kcalErrs) > 0 && medErr > 0.20 {
		t.Errorf("median kcal error %.2f > 0.20", medErr)
	}
}

// unlimitedMeter satisfies the resolver's Meter interface without touching the
// billing table — the eval measures resolution quality, not budget.
type unlimitedMeter struct{}

func (unlimitedMeter) Record(ctx context.Context, userID uuid.UUID, u Usage, costUSD float64) error {
	return nil
}
func (unlimitedMeter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	return true, nil
}
```
> A photo eval (`TestEvalPhoto`) mirrors this against `photos.jsonl` + `resolver.ResolvePhoto`; scaffold it the same way but keep it optional (skip if `photos.jsonl` absent). Add it only if time permits — the chat runner is the exit-gate core.

- [ ] **Step 3: Verify the harness builds and runs against the sample**

Run (build check, no keys needed): `cd api && go vet -tags eval ./internal/ai/`
Then, if local DB + GEMINI_API_KEY available (controller step): `cd api && set -a && . ./.env && set +a && KORA_EVAL=1 go test -tags eval ./internal/ai/ -run TestEvalChat -v` and confirm it runs against `chat.sample.jsonl` and prints metrics.

- [ ] **Step 4: Commit**

Run: `cd api && gofmt -l . && go vet -tags eval ./internal/ai/`
```bash
git add api/internal/ai/eval_test.go api/testdata/eval
git commit -m "feat(api): eval harness scaffold for resolution engine (dataset user-provided)"
```

> **Blocked / follow-up:** the real `chat.jsonl` + `photos/` golden dataset is USER-PROVIDED. Once added, run the A/B: `KORA_EVAL=1 KORA_EVAL_PROVIDER=gemini` vs `KORA_EVAL_PROVIDER=fallback` and compare metrics to pick/confirm the free stack. This is the Phase 2 exit gate.

---

## Self-Review (Phase 2c handoff coverage)

1. **Resolve API endpoints (text/photo/barcode) mounted** → Task 3 (handler + routes) + Task 4 (main wiring + live smoke). ✓
2. **Free fallback wiring (NVIDIA via OpenAI adapter, base URL + model configurable, json_object compat, optional)** → Task 2 (adapter + config) + Task 4 (Router only when fallback key present). ✓ (Live NVIDIA verified: json_object works; strict schema slow/degenerate → compat path chosen.)
3. **Real cost pricing into estimateCostUSD (budget gate live)** → Task 1 (list-price rate table `EstimateCostUSD` + per-user call-count cap + created_at index). ✓
4. **Event.UserID json:"-"** → Task 1 Step 7. ✓
5. **Correction loop (aliases lower+trim)** → Task 5 (`AddAlias` lower+trim + `EditLog` records alias on food correction). ✓ (Full log-edit endpoint per user decision.)
6. **Embedding backfill (cmd/embed, 768-dim, 85 rows)** → controller operational step after Task 4 (has the Gemini key): `cd api && set -a && . ./.env && set +a && go run ./cmd/embed` then verify `select count(*) from food_items where embedding is not null;` == 85 and that an embedding-only query resolves via `MatchEmbedding`. ✓ (Deferred to controller — operational, needs live key.)
7. **Eval harness scaffold (exit gate, dataset user-provided)** → Task 6. ✓
8. **Carry-forward minors:** metering embed-error noise row fixed (Task 1 Step 5); WithinBudget scan index (Task 1 Step 10). Router-discards-primary-Usage-on-error and decompose-hardcodes-TierConfirm remain deferred Minors (noted, not blocking).

**Placeholder scan:** none — every code step carries complete code. Test helper names (`testDB`/`seedUser`/`seedFoodItem`/`resolveUser`) are flagged to be reconciled against the actual existing helpers in each test file (read-first notes included).

**Type consistency:** `EstimateCostUSD(Usage) float64` used in Task 1 and Task 6; `TextPhotoResolver`/`BarcodeResolver`/`resolve.Handler`/`Deps.Resolver` consistent across Tasks 3–4; `EditRequest`/`EditLog`/`Repository.Update`/`AddAlias` consistent across Task 5; `NewOpenAIProvider(apiKey, baseURL, model, jsonObject)` consistent across Tasks 2 and 4 and 6.

## Prerequisites / follow-ups

- `api/.env` (gitignored): `GEMINI_API_KEY` (present, verified), and for the fallback `OPENAI_API_KEY=<nvapi key>`, `OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`, `OPENAI_MODEL=meta/llama-3.3-70b-instruct`, `OPENAI_JSON_OBJECT=true` (controller adds in Task 2).
- SDK field names (`openai-go` json_object response format; `go-redis/v9` ParseURL/NewClient) verified against installed versions in Tasks 2/4 — adapt if they differ.
- **Mobile wiring of the resolve endpoints (camera→/resolve/photo, text/mic→/resolve/text, scan→/resolve/barcode) is OUT OF SCOPE for 2c** (backend engine + API only) — a later phase, gated by the UI-fidelity review against `design-system/ui_kits/kora/`.
- Verify LLM model IDs against the live API, never training memory (already done: Gemini 3.5 IDs + NVIDIA llama-3.3-70b confirmed live).
