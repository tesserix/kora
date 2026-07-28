# Handoff — Saved Meals (Usual-Meal Naming & Editing, Food Memory Phase 2f)

Continue in a fresh session. **Trust `.superpowers/sdd/progress.md` (SDD ledger, gitignored) + `git log` over recollection.**

## IMMEDIATE TASK
Execute the **Saved Meals** plan, subagent-driven, on branch **`usual-meals`** (already checked out, off `main`).
- Plan: `docs/superpowers/plans/2026-07-28-kora-saved-meals.md` — **7 tasks, full code each.** Spec: `docs/superpowers/specs/2026-07-28-kora-saved-meals-design.md`.
- **Base for Task 1 = `9aa29b6`** (plan commit, current HEAD of `usual-meals`).
- Per task (superpowers:subagent-driven-development): `scripts/task-brief <plan> N` → dispatch implementer → `scripts/review-package BASE HEAD` → dispatch reviewer → fix Critical/Important → append one ledger line → next. Scripts: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/`.
- Model per task: T1-2 (Go, DB-backed) sonnet; T3-7 (mobile) sonnet (or haiku for pure transcription). Reviewers sonnet; **final whole-branch review opus** (base `origin/main`).
- After 7 tasks: final review → device-verify → PR (base **main**; not stacked). `gh pr merge` is classifier-gated → **user merges**.

## THE 7 TASKS (all full code in the plan)
1. **Go** — migration `000017_saved_meals` + models + repository (Create/List/ItemsForMeals[join]/Replace/Delete/Count, two-table txn) + repo tests.
2. **Go** — service (enrich per-100g×grams/100 no-round, validate, cap 50) + handler + `/v1/saved-meals` GET/POST/PUT/DELETE + service/handler tests.
3. **Mobile** — types (`SavedMeal`/`SavedMealItem`/`LoggableMeal`) + hooks (useSavedMeals/create/update/delete) + `logMeal` retype `MemoryMeal`→`LoggableMeal` + hook test.
4. **Mobile** — `bookmark`/`bookmark-fill` glyph in Icon + `bookmarked`/`onBookmark` star-style affordance on MealRow (separate Pressable) + MealRow test.
5. **Mobile** — `SavedMealSheet` editor + `SavedMealSheetProvider` (root, mirrors ToastProvider) + mount in `app/_layout.tsx` + sheet test.
6. **Mobile** — Log "Saved" tab (first) + bookmark on usual_meals rows + test.
7. **Mobile** — `SavedMealsStrip` on Home (above PinnedStrip) + index mount + test.

## KEY DESIGN FACTS
- Usual meals are **derived** (SHA1 of `slot+sorted(food-id set)`, no meal table) — so "editing" must be a **new persisted entity** (saved meals). Naming ≠ editing; both delivered via saved meals.
- **Save-from-usual + curate only**: rename, remove items, adjust grams. NO adding foods / no build-from-scratch (keeps food-search out).
- Macros server-side (`per100g × grams / 100`, no round). Logging reuses `logMeal`→`POST /v1/logs/batch`. Cap 50.
- `ItemRow` join risk (T1): `AS kcal_per100g` aliases map to GORM fields — the T2 enrichment test's exact-kcal assertion guards it.

## ENVIRONMENT / GOTCHAS (from prior phases — see [[kora-mobile-devbuild-fidelity]])
- **Postgres UP** (docker `infra-postgres-1`, healthy, localhost:5432). Go tests: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go test -race -p 1 ./internal/savedmeals/...` FOREGROUND. Run `go run ./cmd/migrate` (same env) first to apply `000017`. A `t.Skipf` SKIP is NOT a pass — verify tests RAN.
- Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` FOREGROUND. RNTL v14 → `await render`. `mock`-prefixed closure vars in `jest.mock()` (babel-jest-hoist). Stale LSP "undefined" after adding Go symbols is benign — trust build/test.
- **Device-verify** at the end (API must be up: `cd api && go build -o /tmp/kora-api ./cmd/api` then run with `.env` sourced; Metro `cd apps/mobile && npx expo start --dev-client --port 8091`). Two dev-client ping-pong + HMR reloads make idb multi-step flaky — launch Kora by bundle id (`xcrun simctl launch <udid> com.tesserix.kora`) after killing admin metro; verify UI surfaces render confidently, treat modal CRUD as best-effort (unit tests cover logic). SDD report files at `.superpowers/sdd/task-N-report.md` are gitignored scratch — reused per track, safe to overwrite.

## STATE (as of 2026-07-28)
- **`main` = `331a97f`** — has food-memory, fibre-tile, meal-reminders v1, custom-reminders v2, pins (all merged, #7-#12).
- **`usual-meals`** (HEAD `9aa29b6`) — spec + plan committed, **NOT built**. Work here.
- No open PRs.

## WORKING AGREEMENTS
Subagent-driven ALWAYS (never ask inline-vs-subagent). No fabricated numbers (macros server-side; client sends food_item_id+grams). User isolation every query. Two-table writes in a txn. Tokens-only mobile styling; reuse MealRow/Sheet/Segmented/useInstantLog. Single-line conventional commits, no signature, **never `git add -A`** (stage named files). Device-verify at the end. Immutability, comprehensive error handling.

## AFTER SAVED MEALS
Food Memory Phase 2 is then complete (usual strip, fibre, reminders, custom reminders, pins, saved meals). No known remaining Phase 2 backlog.
