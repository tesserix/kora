# Handoff — Kora Phase 2c (Resolve API + Eval Harness)

**Date:** 2026-07-24. Written to continue in a fresh session.

## Authoritative state
- **Progress ledger (READ FIRST):** `.superpowers/sdd/progress.md` — every task/phase, its commits, review outcomes, and all deferred/carry-forward items. Trust it + `git log` over any recollection.
- **Branch:** `phase-2-nutrition-engine` (Phase 2a+2b). **PR #5** open → base `phase-1c-ui-fidelity`. Tree clean.
- **Specs:** `docs/superpowers/specs/2026-07-24-kora-build-design.md` (parent §3) and `…-kora-phase2-nutrition-engine.md` (Phase 2 design, approved).
- **Plans:** `docs/superpowers/plans/2026-07-24-phase-2a-food-index.md`, `…-phase-2b-resolution-engine.md`.

## Shipped (all reviewed; both whole-branch reviews MERGEABLE)
- **PR #4** — Phase 1c UI fidelity (branch `phase-1c-ui-fidelity`) + log-screen back-nav fix. Live-verified on the sim.
- **PR #5** — **Phase 2** (this branch):
  - **2a Food index:** pgvector migration `000004` (`embedding vector(768)`, `normalized_name`, HNSW+btree), `000005` FTS GIN index; `Normalize`; tiered `Resolve` (alias lower/trim → full-text on `normalized_name` → embedding cosine); OpenFoodFacts barcode fallback (never fabricates a row); curated AFCD/USDA ingestion + `cmd/ingest`; `/v1/foods` returns `Candidate[]`; mobile `useFoodSearch` maps `.item`.
  - **2b Engine (`ai/` + `billing/`):** `ai.Provider` interface, `Router` (Gemini→OpenAI fallback), `Resolver` (identify→embed→`nutrition.Resolve`→tiers→decompose→portion ranges), optional Redis `Cache`, `billing` metering (`ai_usage_events` migration `000006`), Gemini + OpenAI adapters, `cmd/embed`. **Hard invariant enforced at 3 layers** (types/schemas/resolver): kcal ALWAYS = `row.KcalPer100g × grams / 100`; the LLM only identifies. Built stub-first (no live LLM in `go test`; adapters have `//go:build smoke` tests).

## Keys (in `api/.env`, gitignored)
- **`GEMINI_API_KEY` — VERIFIED LIVE & WORKING (free tier).** Models fixed to available IDs (commit `ca93e98`): photo `gemini-3.5-flash`, chat/decompose `gemini-3.5-flash-lite`, embed `gemini-embedding-001` @ `OutputDimensionality=768`. (Gemini 2.5 + `text-embedding-004` are BLOCKED for new keys.) Smoke tests pass: IdentifyText returns guesses, Embed returns len==768.
- **`NVIDIA_API_KEY` — added (`nvapi-…`, valid), 118 models incl. `meta/llama-3.3-70b-instruct`.** NVIDIA is OpenAI-compatible: base `https://integrate.api.nvidia.com/v1`. Intended as the FREE fallback (replaces paid GPT-5-mini). A live JSON chat test was in-flight (slow cold start) — re-run to confirm generation + whether it supports `response_format:{type:"json_object"}` (NVIDIA may not support strict `json_schema`).
- **`OPENAI_API_KEY`** — NOT set (paid; being replaced by NVIDIA-via-OpenAI-adapter).

## Phase 2c — the work to do (needs its own plan via `superpowers:writing-plans` → subagent-driven)
1. **Resolve API endpoints** — mount the `ai` package in `main.go`/`internal/server/router.go`: `POST /v1/resolve/text|photo|barcode` (GIP-auth `v1` group) → call `ai.Resolver`; responses carry candidates + tier + provenance chip. Wire `NewGeminiProvider`, `Router`, `NewResolver`, `RedisCache`, `billing.Meter` from config.
2. **Free fallback wiring** — add `OPENAI_BASE_URL` + `OPENAI_MODEL` to `config` and make `providers.NewOpenAIProvider` accept a base URL (openai-go `option.WithBaseURL`) so the fallback = NVIDIA (`https://integrate.api.nvidia.com/v1`, `meta/llama-3.3-70b-instruct`). Add a `json_object` compat path (NVIDIA models may not accept strict `json_schema`). Make the fallback OPTIONAL (Gemini-only if no fallback key). Verify with a live smoke.
3. **Real cost pricing** — `estimateCostUSD` currently returns `0.0`, so `WithinBudget` never trips in the live path. Wire per-model token pricing (Gemini free-tier = 0 is fine; set caps meaningfully) BEFORE launch.
4. **`Event.UserID` `json:"-"`** — add before any endpoint serializes `Event`.
5. **Correction loop** — edit a logged item → insert/update `food_aliases` (**lower+trim**, NOT `Normalize` — matches `idx_food_aliases_alias`).
6. **Embedding backfill** — run `cmd/embed` (Gemini key present) to populate `food_items.embedding` so the embedding tier lights up (85 rows). It logs+exits 0 without a key.
7. **Eval harness (exit gate)** — `testdata/eval/` schema (`chat.jsonl`, `photos/`), a `go test -tags eval` + `KORA_EVAL=1` runner scoring top-1 id (chat ≥90%, photo ≥80%), resolved-entry correctness ≥90%, median kcal error ≤20%, zero hallucinated rows. **Golden dataset is USER-PROVIDED** (blocked until they add it). Use the harness to A/B Gemini vs the NVIDIA free fallback.

## Carry-forward minors (from reviews — triage in 2c/final)
See ledger for the full list. Notable: metering undercounts a billed-but-failed primary call; resolver meters embedding usage even when Embed errored; `WithinBudget` global SUM seq-scans (add `created_at` index if it grows); decompose hardcodes `TierConfirm`. All Minor/deferred.

## Working agreements (this project)
- Flow: `superpowers:brainstorming` (if creative) → `superpowers:writing-plans` → **`superpowers:subagent-driven-development`** (fresh implementer subagent per task + a spec+quality review subagent per task; fix Critical/Important before moving on; final whole-branch review on opus). Use the ledger + `scripts/task-brief`/`review-package` under the subagent-driven skill dir.
- Tell implementer subagents to run tests **FOREGROUND** (they stall on background test runs). Stale RED LSP diagnostics after a task are normal (test written before impl) — verify with a build.
- Go: `go test -race -p 1`; integration tests skip (not fail) without Postgres; local Postgres is `pgvector/pgvector:pg15` on `localhost:5432` (db `kora`, user `kora`/`kora_dev`), migrated, ~85 food rows. `DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable'`.
- Commits: conventional, single-line, no signature.
- Frontend changes: match `design-system/ui_kits/kora/` mockups + review via idb sim screenshot before merge (see `.superpowers` memory `ui-fidelity-gate`).
- Verify LLM model IDs against the LIVE API (`/v1/models`) — training-cutoff model names (Gemini 2.5, text-embedding-004) are stale/blocked for new keys.
