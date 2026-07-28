# Handoff — Kora Personal Food Memory (2026-07-27)

Continue in a fresh session. **Trust `.superpowers/sdd/progress.md` (the ledger, gitignored) + `git log` over recollection.**

## Read first (in order)
1. `.superpowers/sdd/progress.md` — authoritative ledger. The `=== PERSONAL FOOD MEMORY v1 ===` section is the live state.
2. This file.
3. Plan: `docs/superpowers/plans/2026-07-27-kora-personal-food-memory.md` (8 tasks, full code per task).
4. Spec: `docs/superpowers/specs/2026-07-27-kora-personal-food-memory-design.md`.

## State
- **Branch `food-memory`** (off `main`). `main` = `8541060` (the merged elevated-v2: crash fix + Apple Health + imperial/metric units + dock polish). Not pushed; local only.
- Branch commits: `8bd9b83` spec · `a0f20d2` plan · `e716abc` Task 1 · `3fd39ea` Task 2. HEAD `3fd39ea`.
- **Feature:** Personal Food Memory v1 — the differentiator wedge ("easiest tracking ever"). Backend `GET /v1/memory` (Recents/Frequent/auto-detected Usual-meals from `food_logs`) + atomic `POST /v1/logs/batch` + a Log-screen memory library with one-tap instant-log + Undo toast.

## Execution: subagent-driven-development (SDD)
Running via `superpowers:subagent-driven-development`. Per task: `scripts/task-brief <plan> N` → dispatch implementer (sonnet) → `scripts/review-package BASE HEAD` → dispatch reviewer (sonnet) → fix Critical/Important + re-review → ledger line. Skill dir: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development`.

**Progress:** Task 1 ✅ (`e716abc`) · Task 2 ✅ (`3fd39ea`) · Tasks 3–8 pending. **Base for Task 3 = `3fd39ea`.**

## DO FIRST next session
**Apply the deferred Task-2 Important fix** (one line, plan-mandated): `foodlog.CreateBatch` (`api/internal/foodlog/service.go:206-208`) maps *every* `foods.GetByID` error to a 400 `ValidationError` — infra/DB faults are misclassified as client errors. Fix: mirror `EditLog` (`service.go:130-137`) — `errors.Is(err, gorm.ErrRecordNotFound)` → `ValidationError` (400), else wrap `fmt.Errorf(...%w)` → 500 via `RespondServiceError`. Add a not-found-vs-infra test. Commit, re-run `./internal/foodlog/`, ledger it. Then resume SDD at **Task 3**.

## Remaining tasks (plan has full code for each)
3. `memory` pkg: types + `recents`/`frequent` (pure). 4. `usualMeals` clustering. 5. `GET /v1/memory` handler + router wiring. 6. mobile `useMemory`/`useCreateLogBatch` hooks + types. 7. mobile Undo `Toast` provider (none exists — new). 8. mobile Log-screen memory library. Then: final whole-branch review (opus) → device-verify on sim → `superpowers:finishing-a-development-branch` (PR).

## Environment / gotchas
- **Postgres** running via `infra/docker-compose.yml` (pgvector/pg15, healthy). Go DB tests need `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`. Run Go tests FOREGROUND: `cd api && TEST_DATABASE_URL=... go test -race -p 1 ./internal/<pkg>/`.
- **Kora Metro on 8091** still running (bg task `br8rqk3op`). Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` foreground; RNTL v14 → `await render`.
- **Sim:** iPhone 17 Pro `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`, app `com.tesserix.kora`. idb tap = displayed_px×1.31÷3. **Two-dev-client ping-pong:** the Mark8ly Admin dev client (`com.mark8ly.admin`) steals foreground via the shared `exp+mobile://` scheme — its Metro (8082) was killed this session; if it resurfaces, `xcrun simctl terminate <udid> com.mark8ly.admin` + bare-launch Kora, or kill its Metro. To load a fresh Kora bundle you must re-open the deep link (bare launch keeps a stale bundle).
- **Stale LSP diagnostics:** after adding a Go method/type, the editor may show `undefined` — benign; verify via `go test`/`go build` (this happened on both Task 1 and 2, both false).
- **Report-file collisions:** `.superpowers/sdd/task-N-report.md` names are reused across plans; subagents overwrite the stale one (benign, old content in git history).
- `gh` active account = **mahesh-sangawar** (org access).

## Working agreements
No fabricated numbers (macros = item per-100g × grams, server-side; client never sends macros). User isolation on every query. TZ via `LocFromContext`. Tokens-only mobile styling. Single-line conventional commits, no signature, **never `git add -A`** (untracked `ios/`, `.superpowers/`, `docs/` exist). Preserve invariants with unmodified proof tests. Device-verify native/animated components at the end (jest can't catch worklet/native/layout).
