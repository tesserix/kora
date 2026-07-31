# Alias Short-Circuit — Implementation Plan (PR3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make a post-log correction actually take effect on the main capture path, and make it instant and free.

**Architecture:** `ai.Resolver.ResolveText` checks the caller's personal food alias for the raw phrase *before* calling the LLM. On a hit it returns a one-candidate `Resolution` built from the aliased food row, portioned from the user's last log of that same phrase. No LLM call, no metering, no cache round-trip.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL 15.

## The bug this fixes

`nutrition.AddAlias` stores a correction alias under the user's **raw phrase** (`lower(trim(food_logs.input_phrase))`). But `ai.Resolver.ResolveText` goes straight to the LLM, and `resolveGuesses` then calls `foods.Resolve(ctx, userID, guess.Food, …)` — the **model's** food string. The personal-alias tier only fires when the model happens to echo the user's exact wording.

So today: correcting "brekkie eggs" → quinoa works in `GET /v1/foods` (the picker, manual search) but **not** in `POST /v1/resolve/text`, which is how people actually log. Cache eviction works, which only means the next resolve spends a fresh AI call to return the same wrong answer.

This shipped in #63. It makes #64's "Kora will remember …" copy overstate what the system does.

## Global Constraints

- **Nutrition is never invented.** Every kcal/macro must come from a `nutrition.FoodItem` row: `kcal = KcalPer100g * grams / 100`. The short-circuit must not fabricate a number.
- The alias lookup is **per-user**. `uuid.Nil` must never match another user's personal alias. Curated/global aliases (`user_id IS NULL`) are out of scope for the short-circuit — they are not corrections.
- A short-circuit must **not** meter AI usage — no provider call happened.
- Run tests in the FOREGROUND. `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable`.
- Do NOT run `go run ./cmd/seed`.
- CI equivalent: `cd api && go vet ./... && go test -race -p 1 -count=1 ./...`
- Conventional single-line commit messages. No trailers, no signatures.
- No migration. This is Go-only.

## Portion decision

An alias hit tells us *which* food, not *how much* — the LLM was what estimated portion. Decision: **reuse the portion from the user's most recent log of that same phrase**, since `food_logs.input_phrase` already records it. Correcting once teaches food *and* portion.

Fallback order: last logged portion for that phrase → the food's `serving_grams` when > 0 → 100g (the convention the barcode path already uses).

---

### Task 1: Personal-alias lookup and last-portion lookup

**Files:**
- Modify: `api/internal/nutrition/alias.go` (add `LookupPersonalAlias`)
- Modify: `api/internal/foodlog/repository.go` (add `LastPortionForPhrase`)
- Test: `api/internal/nutrition/alias_test.go`, `api/internal/foodlog/repository_test.go`

**Interfaces produced:**
- `func (r Repository) LookupPersonalAlias(ctx context.Context, userID uuid.UUID, phrase string) (FoodItem, bool, error)` — nutrition. Returns `found=false` (not an error) on no match. `uuid.Nil` returns `found=false` without querying. Matches on `lower(trim(phrase))`, `user_id = ?` only — never `user_id IS NULL`.
- `func (r Repository) LastPortionForPhrase(ctx context.Context, userID uuid.UUID, phrase string) (float64, bool, error)` — foodlog. Most recent `food_logs.quantity_grams` where `user_id = ?` and `lower(trim(input_phrase)) = lower(trim(phrase))`, ordered by `logged_at DESC`. Returns `found=false` on no match.

- [ ] **Step 1: Write failing tests** covering, for `LookupPersonalAlias`: a hit for the owner; no hit for a different user; no hit for a curated/global row with the same phrase; case/whitespace insensitivity; `uuid.Nil` returns not-found. And for `LastPortionForPhrase`: returns the most recent matching log's grams; ignores other users' logs; ignores logs with a NULL `input_phrase`; returns not-found when nothing matches.
- [ ] **Step 2: Run them, confirm they fail to compile** (methods undefined).
- [ ] **Step 3: Implement both**, mirroring the existing query style in each file.
- [ ] **Step 4: Run them, confirm they pass.**
- [ ] **Step 5: Prove the cross-user test is load-bearing** — drop the `user_id = ?` predicate from `LookupPersonalAlias`, confirm the "no hit for a different user" test FAILS, restore, confirm PASS.
- [ ] **Step 6: Commit** — `feat(api): look up a personal alias and the last portion for a phrase`

---

### Task 2: Short-circuit `ResolveText` on an alias hit

**Files:**
- Modify: `api/internal/ai/resolver.go`
- Modify: wherever `ai.NewResolver` is constructed (find it — check `api/cmd/api/main.go` and `api/internal/server/router.go`)
- Test: `api/internal/ai/resolver_test.go`

**Interfaces produced:**
- `type PortionSource interface { LastPortionForPhrase(ctx context.Context, userID uuid.UUID, phrase string) (float64, bool, error) }` in package `ai`.
- An **optional, nil-safe** way to give a `Resolver` a `PortionSource` — follow the existing `WithResolutionCache` setter pattern used by `foodlog.Service` rather than adding a parameter to `NewResolver`, so existing construction sites keep working. A nil `PortionSource` must fall back to `serving_grams`/100g, never panic.

- [ ] **Step 1: Write the failing tests.** Required cases:
  - a personal alias hit returns that food **without invoking the provider at all** (assert the fake provider's call count is unchanged) and **without metering**;
  - the returned candidate's kcal equals `KcalPer100g * grams / 100` for the resolved grams — row-sourced, not fabricated;
  - the portion comes from the user's last log of that phrase when one exists;
  - it falls back to `serving_grams` when there is no prior log, and to 100g when `serving_grams` is 0;
  - a nil `PortionSource` does not panic and falls back the same way;
  - **no alias → the existing LLM path runs unchanged** (this is the regression guard: assert the provider IS called);
  - another user's alias does not short-circuit this user.
  - Tier is `TierAuto` and the candidate's `MatchTier` is `nutrition.MatchAlias`.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement.** In `ResolveText`, before `r.resolve(...)`: call `LookupPersonalAlias`. On a hit, resolve the portion (last-portion → `serving_grams` → 100), build the one-candidate `Resolution` with kcal from the row, and return it. On a miss or any error, fall through to the existing path — **a lookup failure must never break resolution**; log it and continue.
- [ ] **Step 4: Run them, confirm they pass.**
- [ ] **Step 5: Prove the short-circuit is load-bearing** — remove the early return so the alias hit falls through to the LLM, confirm the "does not invoke the provider" test FAILS, restore, confirm PASS.
- [ ] **Step 6: Wire the `PortionSource`** at the construction site, then run `go vet ./...` and the full race suite.
- [ ] **Step 7: Commit** — `feat(api): resolve a corrected phrase from its personal alias without calling the model`

---

### Task 3: PR

- [ ] Full check: `cd api && go vet ./... && go test -race -p 1 -count=1 ./...`
- [ ] Open the PR. Body must state: the bug (alias keyed on the raw phrase, looked up under the model's guess), that this closes the loop for `/resolve/text`, that corrections now cost nothing and return instantly, and the portion-inheritance rule. Refs #20.
- [ ] Report the PR URL and CI status. Do not merge.

## Self-Review

**Coverage:** the bug is closed by Task 2's short-circuit; the per-user constraint by Task 1's scoped query and its load-bearing proof; the nutrition invariant by Task 2's kcal assertion; cost by the "provider not invoked" assertion; the regression risk by the "no alias → LLM path unchanged" case.

**Not in scope:** `/resolve/photo` and `/resolve/voice` (a photo has no raw phrase; voice already delegates to `ResolveText`, so it inherits the fix). Curated/global aliases. Any change to the alias-writing side.
