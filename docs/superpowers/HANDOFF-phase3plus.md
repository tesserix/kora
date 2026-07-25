# Handoff — Kora after the "post-Phase-3" feature run

**Date:** 2026-07-25. Written to continue in a fresh session.

## Authoritative state (READ FIRST, in order)
1. **Progress ledger:** `.superpowers/sdd/progress.md` — every phase/task/feature, commits, reviews, deferred minors, live-verification notes. Trust it + `git log` over recollection.
2. This file.
3. Prior handoff: `docs/superpowers/HANDOFF-phase3.md` (state up to the Phase 3 fidelity gate).
4. Specs/plans for the features below live in `docs/superpowers/specs/` + `docs/superpowers/plans/` (dated `2026-07-25`).

## Branch / PR
- Branch **`phase-2-nutrition-engine`**, **PR #5** (base `phase-1c-ui-fidelity`), **HEAD `ae56937`, all pushed, tree clean** (only `.idea/` untracked).
- PR #5 now bundles a LOT: Phase 2 (nutrition engine) + Phase 3 (AI capture) + Phase-3 fidelity gate + Home→capture wiring + deferred-minors cleanup + **3 follow-on features** (below). **Consider whether PR #5 should be split** before the merge chain.

## What shipped this session (all pushed, all reviewed MERGEABLE)
1. **Phase 3 fidelity gate PASSED** (live idb-sim review of `/capture` vs `CaptureScreen.jsx`) + 2 fixes (empty-name greeting, dark-surface DetectedCard tiles). Commit `656136b`.
2. **Home → capture wiring** — the "Snap a meal" hero + the (previously dead) "Add a meal" affordance now route to `/capture`; same greeting fix on Home. Commit `86b6e8b`. **Live-verified.**
3. **Deferred-minors cleanup** (subagent-driven, opus final review) — commits `08ddea1`..`df1184e`: nutrition test-isolation (Seed test now runs in a rolled-back tx; foods-endpoint de-flaked), foodlog alias-write now logged (not swallowed), capture send-button whitespace + `kcalTotalLabel` dedup, mobile test coverage.
4. **FEATURE: edit/delete a log + quick-add water** (brainstorm→spec→plan→subagent-driven, opus READY TO MERGE) — commits `be8d1fd`..`68d06c2`. Editable `app/meal.tsx` (grams `Stepper`, meal-slot chips, delete-with-confirm), `useEditLog`/`useDeleteLog` hooks, Diary +250/+500 ml water. Invariant held (PATCH sends only `quantity_grams`/`meal_slot`). **Live smoke NOT done for this one.**
5. **FEATURE: weight tracking** (full-stack, brainstorm→spec→plan→subagent-driven, opus READY TO MERGE) — commits `d05f747`..`ae56937`. Migration `000008` `weight_entries` + `AddWeight`/`WeightSeries` in `internal/tracking` + `POST`/`GET /v1/weight`; mobile `useAddWeight`/`useWeightSeries`, Progress reads real data (current/delta/functional 1W/1M/3M/1Y toggle/seed-from-onboarding-weight/chart≥2pts), tap-weight-card→`WeightLogSheet`. **LIVE-VERIFIED end-to-end** (seed 80.0kg → sheet prefilled → save wrote 78.58 → card 78.6kg).

Test status: mobile **142/142 + tsc clean**; backend `-race -p1` green against `kora_test`. CI on PR #5 still RED = pre-existing GitHub Free Actions billing (jobs die ~2s, "log not found") — code passes CI's exact commands locally.

## Known caveats / environment gotchas
- **Live rig is flaky.** The dev-client drops its Metro connection when idle (→ red "No script URL" box / springboard / cold relaunch). The dev `.app` also got uninstalled mid-session. To recover: reinstall from DerivedData (`xcrun simctl install booted <…/mobile-*/…/Debug-iphonesimulator/mobile.app>` — no rebuild needed since it's a dev build), start Metro (`cd apps/mobile && npm run ios` OR `npx expo start --port 8091`), then `xcrun simctl openurl booted "mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8091"`. Sign in fresh each install: `demo@kora.app` / `KoraDemo123!` (type email in segments — idb mangles `demo@…`: tap Email, type `demo`, verify, then `@`, then `kora.app`). idb at `~/Library/Python/3.9/bin/idb` (+ homebrew `idb_companion`); booted UDID `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`; tap points = px/3.
- **STALE BACKEND TRAP (bit me this session):** a backend started early in a session predates later-added routes. After adding endpoints, **restart `go run ./cmd/api`** or the app gets 404/500 with "Couldn't save".
- **DB DRIFT TO INVESTIGATE:** both `kora` and `kora_test` had a stray `weight_entries` table with an extra **`body_fat_pct`** column from some earlier run, leaving `schema_migrations` **dirty at v8** (backend refused to boot). Fixed by `DROP TABLE weight_entries; UPDATE schema_migrations SET version=7, dirty=false;` then reboot (re-applies 000008 cleanly). **Source of that stray table is unknown — worth a look** (not from committed migrations, which are clean).
- **Food index** still needs re-seed for live resolve after nutrition tests run (see `kora-food-index-test-state` memory): `cd api && set -a && . ./.env && set +a && go run ./cmd/seed && go run ./cmd/ingest -afcd testdata/food/afcd_staples.json -usda testdata/food/usda_common.json && go run ./cmd/embed`.

## Open functional gaps (product), roughly by value
- **Live smoke of edit/delete + water** — built, unit-tested, reviewed, but not driven on-device this session (backend is now current, so they'd work).
- **Repeat / copy-a-day** — backend endpoints exist (`POST /logs/:id/repeat`, `/logs/copy-day`); `useCopyDay` hook exists but is wired to nothing; no repeat hook, no UI. **Natural next small mobile feature.**
- **Deferred Minor (weight):** "current weight" headline is range-scoped — when the selected range has no entries but older ones exist, it falls back to the onboarding seed. Needs a range-independent "latest" fetch. Number is still real; edge only.
- **Dead buttons:** Home coach button, Progress "Weekly report", capture top-right "Photo library" shortcut — all no-ops.
- **Capture paths** — photo (Gemini vision) / voice (device mic) / barcode (device camera) wired + unit-tested but not live-verified with real inputs (text resolve is verified). Barcode + voice need a device.
- **Steps / sleep** on Progress are still static placeholders (no data source).
- **Future phases:** coaching (Phase 6 — Otto notes/headline are static), social auth (Google/Apple), password reset.
- **Phase 2 eval exit gate:** the golden dataset is user-provided (`api/testdata/eval/chat.jsonl` + `photos/`); harness ready. Run `KORA_EVAL=1 KORA_EVAL_PROVIDER=gemini|fallback go test -tags eval ./internal/ai/`.
- **PR merge chain:** `phase-2-nutrition-engine` → `phase-1c-ui-fidelity` → `1b` → `1a` → `main` — a decision + reviews.

## Working agreements (this project — unchanged)
- Flow: `superpowers:brainstorming` (creative) → `superpowers:writing-plans` → **`superpowers:subagent-driven-development`** (fresh implementer + spec/quality reviewer per task; fix Critical/Important before moving on; final whole-branch review on **opus**). Use the ledger + this skill's `scripts/task-brief`/`review-package`. **Never ask "subagent-driven or inline?" — always subagent-driven** (user global pref). Base for a task's review-package = the commit before that task (NOT `HEAD~1`).
- Backend DB tests run against **`kora_test`** (isolated): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1`. Postgres = docker `infra-postgres-1`.
- Tell implementer subagents to run tests **FOREGROUND**. **Stale RED LSP diagnostics after a test-before-impl task are normal — verify with `go build`/`go test`, not the LSP** (bit me twice this session on Go tasks).
- Mobile: `npx tsc --noEmit` + `npm test -- --ci`; RNTL v14 async `render`/`fireEvent`; jest.mock factories only reference `mock`-prefixed vars. Conventional single-line commits, no signature.
- Verify LLM model IDs against the live API; read live Expo v57 docs before native code. Push is outward-facing — **confirm before pushing** (user has approved every push this session).

## Keys (`api/.env`, gitignored)
`GEMINI_API_KEY` (free, verified). Fallback = NVIDIA free: `OPENAI_API_KEY=nvapi-…`, `OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`, `OPENAI_MODEL=meta/llama-3.3-70b-instruct`, `OPENAI_JSON_OBJECT=true`. `DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`. Demo account `demo@kora.app` / `KoraDemo123!`.

## Likely next moves (pick with the user)
1. Live-smoke edit/delete + water (quick, closes the on-device gap for those two).
2. Build **repeat / copy-a-day** (backend-ready, mobile-only — the natural next small feature).
3. Fix the deferred weight Minor (range-independent "current weight").
4. Provide the eval golden dataset → run the Phase 2 exit-gate A/B.
5. Decide the **PR split / merge-chain** strategy (PR #5 is getting large).
6. Investigate the stray `weight_entries(body_fat_pct)` DB drift.
