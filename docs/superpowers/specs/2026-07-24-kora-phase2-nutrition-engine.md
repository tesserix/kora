# Kora Phase 2 — Nutrition Resolution Engine (Design)

**Date:** 2026-07-24
**Parent spec:** [2026-07-24-kora-build-design.md](./2026-07-24-kora-build-design.md) §3 (Nutrition Resolution Engine), §5 (Cross-cutting), Phase 2.
**Status:** Approved (brainstorming). Next: implementation plans (2a → 2b → 2c).

## Goal

Build the AI nutrition-resolution engine: turn a food photo, chat phrase, or barcode into a
resolved `FoodItem` (or an explicitly-flagged estimate) with visible provenance and a
confidence tier — **without the LLM ever emitting a nutrition number that gets stored**.
Gated by an eval harness that meets accuracy targets on a human-verified golden dataset.
Minimal API only; no new capture UI (that is Phase 3).

## Locked decisions (from brainstorming)

1. **Full Phase 2 in one milestone**, built as three stacked plans in dependency order:
   **2a Index → 2b Engine → 2c Eval**.
2. **Provider access is available** (Gemini + OpenAI keys). Model routing follows the parent
   spec: Gemini 2.5 Flash (vision), Gemini Flash-Lite (chat parsing), GPT-5-mini (fallback),
   Gemini `text-embedding-004` (768-dim embeddings).
3. **Golden dataset is user-provided.** This spec defines the on-disk schema; the user
   populates the real photos/phrases. The harness skips gracefully when the dataset is
   absent so normal CI stays green.
4. **Food index scope: curated + on-demand barcodes.** Bulk-ingest AFCD (AU staples) + a
   curated common-foods subset of USDA FDC as `FoodItem` rows with embeddings. Barcodes:
   query the OpenFoodFacts API on a local miss and cache the hit as a `FoodItem` row — no
   bulk OFF ingest. Fits the shared db-f1-micro budget.

## Hard invariant (non-negotiable)

The LLM output is parsed for **food identity + portion only** — never nutrition numbers.
Every stored nutrition value comes from a `FoodItem` row, or from an `estimate` assembled
from `FoodItem` rows and flagged as such. A dedicated test asserts no LLM-sourced number is
ever persisted, and the eval harness scores "zero hallucinated nutrition rows".

## Existing schema (grounding)

Already present (migration `000002_phase1_core`):
- `food_items` — id, name, brand, provenance (`afcd|off|usda|label_ocr|user_estimate`),
  `barcode` (unique when non-null), serving_desc, serving_grams, {kcal,protein,carbs,fat,
  fiber}_per_100g, created_at. Indexes: GIN `to_tsvector('simple', name)`, `lower(name)`,
  unique barcode.
- `food_aliases` — id, alias, food_item_id (FK cascade), created_at; index `lower(alias)`.
- `food_logs`, `water_entries`, `weight_entries`.
- `nutrition` package: `model.go` (FoodItem + Provenance consts), `repository.go`
  (`Search` via ILIKE — to be upgraded; `Insert` dedups on barcode then name+brand;
  `GetByID`), `seed.go`/`seed_data.go` (61 AU foods), `handler.go`.

---

## Plan 2a — Food index & resolution search

**Migration `000004_nutrition_index`:**
- `CREATE EXTENSION IF NOT EXISTS vector;`
- `food_items`: add `embedding vector(768)`; add `normalized_name TEXT` (lowercased,
  punctuation-stripped) with an index for alias/FTS matching; add HNSW cosine index on
  `embedding` (`USING hnsw (embedding vector_cosine_ops)`).
- Backfill `normalized_name` for existing seed rows.

**`nutrition` package additions:**
- `normalize.go` — `Normalize(phrase string) string` (lowercase, strip punctuation, collapse
  whitespace, singularize trivial plurals). Pure + unit-tested.
- `repository.go` — replace ILIKE `Search` with a tiered `Resolve(ctx, phrase, embedding)`:
  1. **alias hit** — exact `food_aliases.lower(alias)` match on the normalized phrase.
  2. **full-text** — `to_tsvector('simple', name) @@ plainto_tsquery(...)`, ranked.
  3. **embedding** — cosine similarity on `embedding` (when a query embedding is supplied),
     top-K.
  Returns `[]Candidate{FoodItem, MatchScore, MatchTier}` merged and ranked (alias > FTS >
  embedding; dedup by food_item_id). MatchScore normalized to 0..1.
- `barcode.go` — `ResolveBarcode(ctx, code)`: local `food_items.barcode` hit first; on miss,
  call the OpenFoodFacts product API, map the response to a `FoodItem` (provenance `off`),
  insert (dedup on barcode), and return it. Network failure → not-found, never a fabricated row.

**Ingestion (`nutrition/ingest/`):**
- `afcd.go`, `usda.go` — parse a curated CSV/JSON slice from `testdata/food/` (AFCD staples +
  USDA common-foods subset) into `[]FoodItem`, compute `normalized_name`, and (in 2b, once the
  embedder exists) embeddings. Idempotent upsert via existing `Insert` dedup.
- `cmd/ingest/` — a CLI entrypoint (like `cmd/seed`) to run ingestion + embedding backfill.
  The bundled curated slice is small (hundreds of rows) to fit db-f1-micro; the loaders are
  written to accept larger inputs later.

**Tests (2a):** normalize unit tests; `Resolve` tiered-search integration tests against a
seeded test DB (alias hit beats FTS beats embedding; barcode local-hit and OFF-miss paths
with a stubbed OFF client); embedding search returns nearest by cosine using fixture vectors.
Embedding *generation* is stubbed in 2a (the real embedder lands in 2b); 2a's search accepts a
query vector as input so it is testable without a provider.

---

## Plan 2b — Resolution engine (`ai/` + `billing/`)

**Providers (`ai/providers/`):**
- SDKs: `google.golang.org/genai` (Gemini) + `github.com/openai/openai-go`.
- `ai.Provider` interface: `IdentifyText(ctx, phrase) ([]Guess, Usage, error)`,
  `IdentifyPhoto(ctx, imageBytes) ([]Guess, Usage, error)`,
  `Decompose(ctx, dish) ([]IngredientGuess, Usage, error)`,
  `Embed(ctx, text) ([]float32, Usage, error)`.
  `Guess{Food, PortionEstimate, CookingMethod, Confidence}` — structured/JSON-schema output;
  parsing rejects any numeric nutrition field (invariant guard).
- `router.go` — Gemini primary per call type (Flash vision / Flash-Lite chat / embeddings);
  GPT-5-mini fallback on error or latency-budget breach (photo 3s, chat 1.5s). Keys from env
  (`GEMINI_API_KEY`, `OPENAI_API_KEY`); `.env` local, Secret Manager prod. All calls emit a
  `Usage{provider, model, tokensIn, tokensOut, latencyMs}`.

**Resolution service (`ai/resolver.go`):**
- `Resolve(ctx, ResolveRequest) (Resolution, error)` where request is one of {text, photo,
  barcode}.
- Flow: identify → for each guess, embed the food term (Gemini `text-embedding-004`) and call
  `nutrition.Resolve` → build `[]Candidate` → compute **tier** from
  `min(guess.Confidence, topCandidate.MatchScore)`:
  **≥0.90** auto-suggest (one-tap) · **0.70–0.90** one confirm question ·
  **<0.70** targeted follow-up.
- Unknown dish (no candidate clears the floor) → `Decompose` into index-resolvable
  ingredients → assemble an `estimate`: summed macros from ingredient `FoodItem` rows,
  presented as a range (±15%), provenance `user_estimate`/`estimate` flag set.
- Portion: `guess.PortionEstimate` → grams (and grams range for estimates) → kcal from the
  resolved row's per-100g values. **Numbers only ever come from rows.**
- `Resolution{Candidates, Tier, FollowUpQuestion?, Provenance, IsEstimate, KcalRange?}`.

**Caching + metering:**
- `ai/cache.go` — Redis keyed on `barcode:<code>` / `phrase:<normalized>` / `photo:<sha256>`
  → serialized `Resolution` (TTL). Cache hit returns without an LLM call. Redis optional
  (degrades to no-cache), consistent with the codebase's existing optional-Redis pattern.
- `billing/` — `ai_usage_events` table (migration `000005`): id, user_id, provider, model,
  call_type, tier, tokens_in, tokens_out, latency_ms, cost_usd_est, created_at. `Meter.Record`
  writes one row per call. `Meter.WithinBudget(ctx, userID)` checks a per-user + global monthly
  inference cap (configurable constants; over cap → engine returns a graceful "log it
  manually" signal). Full tiered billing is Phase 8.

**Correction loop (partial, per spec):** when a user corrects a resolved log (wrong food or
portion), the engine writes/updates a `food_aliases` row mapping the original phrase → the
corrected `FoodItem`. Per-user `MemoryPatterns` is deferred to Phase 4.

**Tests (2b):** provider clients tested against recorded/stubbed responses (no live calls in
CI); router fallback on error + timeout; the **invariant guard** test (LLM response carrying a
number is rejected / never persisted); resolver tier boundaries (0.90 / 0.70 edges);
decomposition → range estimate; cache hit skips the provider; `Meter` records events and
enforces the cap. Live-provider tests are behind the `eval` build tag (2c).

---

## Plan 2c — Eval harness & minimal API

**Dataset schema (`testdata/eval/`, user-populated):**
- `chat.jsonl` — one object per line: `{phrase, expected_foods: [{name, per100g?}],
  expected_macros: {kcal, protein_g, carbs_g, fat_g}, portion_grams}`.
- `photos.jsonl` + `photos/<id>.jpg` — `{image: "<id>.jpg", expected_foods: [...],
  expected_macros: {...}}`.
- A tiny committed fixture (2–3 rows, no real images) lets the harness self-test; the real
  dataset is git-ignored and user-provided. Harness skips with a clear message if absent.

**Harness (`ai/eval/`):**
- A `go test`-runnable evaluator behind build tag `eval` **and** an env flag
  (`KORA_EVAL=1`), so it only runs on demand with keys — never in normal `go test`/CI (it
  costs money and needs providers).
- Runs each dataset row through the real engine and scores:
  - **top-1 identification accuracy** — chat ≥ 90%, photos ≥ 80%.
  - **resolved-entry correctness** ≥ 90% (matched the right `FoodItem`/ingredient set).
  - **median calorie error** ≤ 20% vs human-verified.
  - **zero hallucinated nutrition rows** (hard fail if any number lacks a row source).
- Prints a scorecard (per-metric pass/fail vs target). **This is the milestone exit gate and
  the permanent regression suite** for every prompt/model change. Targets are documented
  constants — never silently lowered.

**Minimal API (`nutrition`/`ai` handlers, wired in the router):**
- `POST /v1/resolve/text` `{phrase}` → `Resolution`.
- `POST /v1/resolve/photo` (multipart image) → `Resolution`.
- `POST /v1/resolve/barcode` `{barcode}` → resolved `FoodItem` (local or OFF-cached) or
  not-found.
- Responses carry candidates, tier, follow-up question (if any), provenance chip string
  ("AFCD · verified" / "AI estimate ±15%"), and estimate range. They feed the **existing**
  `foodlog` create flow — logging a chosen candidate reuses the current create endpoint;
  correction after logging triggers the alias-update loop.
- All protected by the existing GIP auth + user-resolve middleware; every resolve call passes
  through `Meter` for metering + budget.

**Tests (2c):** harness fixture self-test (scoring math correct on the committed fixture);
API handler tests (200 with a stubbed resolver, 400 on bad input, 401 unauth); provenance
string formatting.

---

## Cross-cutting (per parent §5)

- **Error handling:** every AI path has a non-AI fallback — manual entry always works.
  Provider down / over budget / low confidence → graceful degrade to manual log or a
  "log it now, fill details later" path. No fabricated nutrition rows, ever.
- **Observability:** structured JSON logs; per-call latency + cost via `ai_usage_events` from
  day one.
- **Success metrics:** the resolve endpoints record source + confidence tier so
  time-to-log / zero-correction-rate / %-by-source stay instrumented.
- **Testing:** Go unit + integration ≥ 80% for new packages; the eval harness is the AI
  regression suite. No live-provider calls in normal CI.

## Out of scope (later phases)

Camera/voice/chat capture UI, OCR nutrition-label fallback, retroactive/natural-language
dates, share-sheet ingestion, "ate half" (all **Phase 3**). Per-user `MemoryPatterns` /
reuse (**Phase 4**). Weight/body tracking (**Phase 5**). Coach/Otto (**Phase 6**). Tiered
billing + monetization (**Phase 8**). Image encryption-at-rest/retention settings arrive with
user photo uploads in **Phase 3** — Phase 2 photos are only user-provided eval fixtures.

## Prerequisites the user provides

- `GEMINI_API_KEY` + `OPENAI_API_KEY` in `api/.env` (and Secret Manager for prod).
- The curated ingestion slice files in `testdata/food/` (AFCD staples + USDA subset) — or
  confirm I should assemble a small starter slice from public sources during 2a.
- The golden dataset in `testdata/eval/` (git-ignored) for the exit gate.
