# Handoff — Kora after Phase 3 (AI Capture)

**Date:** 2026-07-25. Written to continue in a fresh session.

## Authoritative state (READ FIRST, in order)
1. **Progress ledger:** `.superpowers/sdd/progress.md` — every phase/task, commits, reviews, deferred minors. Trust it + `git log` over recollection.
2. This file.
3. Specs/plans: `docs/superpowers/specs/2026-07-24-kora-phase3-ai-capture-design.md`; plans `…/plans/2026-07-24-phase-3a-voice-transcription.md`, `…-phase-3b-mobile-capture.md`. Fidelity ref: `design-system/ui_kits/kora/CaptureScreen.jsx`.
4. Memories (auto-loaded): `kora-food-index-test-state`, `kora-mobile-devbuild-fidelity`, `ui-fidelity-gate`, `subagent-driven-execution`, `subagent-foreground-tests`.

## Branch / PR
- Branch `phase-2-nutrition-engine`, **PR #5** (base `phase-1c-ui-fidelity`), HEAD `e210ea9`, all pushed. PR title covers Phase 2 + Phase 3. Tree clean (only `.idea/` untracked).

## Shipped & reviewed (all green)
- **Phase 2 (2a index, 2b engine, 2c resolve API)** — `/v1/resolve/{text,photo,barcode}`, `ai` engine, live budget gate, full log-edit + correction alias. Live-verified. Final reviews MERGEABLE.
- **Phase 3a — backend voice** — `Transcribe` on `ai.Provider` (Gemini-only; fallback errors like `Embed`; `Router.Transcribe` calls primary directly on a 30s budget). `Resolver.ResolveVoice` → transcribe → existing `ResolveText`. `POST /v1/resolve/voice` (multipart audio, 12MB, bounded-before-parse). **Live-verified**: spoken clip → verbatim transcript ~3s.
- **Phase 3b — mobile capture composer** (`apps/mobile/app/capture.tsx`) — dark full-screen Otto composer, 4 modes (Photo/Text/Voice/Scan) → resolve → tier-aware result → one-tap add-to-diary (retry-deduped, invariant preserved, no silent failures). Dev-build migration (expo-image-picker/camera/audio + config plugins). **117 Jest tests green, tsc clean, `expo prebuild` + `expo run:ios` BUILD SUCCEEDED (0 errors) on iPhone 17 Pro sim.**

## THE ONE REMAINING GATE
**Live idb-sim fidelity review of `/capture` vs `CaptureScreen.jsx`** (per `ui-fidelity-gate`). The dev build compiles + the app runs + Home renders, but the capture-screen *visual* pass wasn't captured (sim renders via Metal so AppleScript can't tap in-sim; `idb` not installed; `simctl openurl mobile://capture` hits an undismissable "Open in mobile?" dialog). **To do it:** `cd apps/mobile && npm run ios` (dev build ~5-8min), tap the center capture button (purple sparkle) → `/capture`. For live resolve, run the backend too (`cd api && go run ./cmd/api`; set `EXPO_PUBLIC_API_URL` to your LAN IP for the sim). To automate taps: `brew install facebook/fb/idb-companion && pipx install fb-idb` (points = px/3 on 17 Pro). See memory `kora-mobile-devbuild-fidelity`. Fix any visual defects vs the mockup, then this gate passes.

## Other known caveats
- **Barcode live-scan is device-only** (iOS sim has no camera) — wired + unit-tested, live path unverified.
- **CI (PR #5) is RED but pre-existing infra** — GitHub Free Actions minutes/billing; fails at `steps:0`/~3s on every commit back before Phase 3. Code passes CI's exact commands locally (`go vet` + migrate + `go test -race -p1`; mobile `tsc` + jest). User should check Settings → Billing → Actions.
- **Local dev food index:** running the nutrition repo tests truncates `food_items` (over-broad cleanup at `internal/nutrition/repository_test.go:31`). Re-seed for live/eval: `cd api && set -a && . ./.env && set +a && go run ./cmd/seed && go run ./cmd/ingest -afcd testdata/food/afcd_staples.json -usda testdata/food/usda_common.json && go run ./cmd/embed` → 85 rows, all embedded. See memory `kora-food-index-test-state`.
- **Phase 2 exit gate still blocked:** the eval golden dataset (`api/testdata/eval/chat.jsonl` + `photos/`) is user-provided; then `KORA_EVAL=1 KORA_EVAL_PROVIDER=gemini|fallback go test -tags eval ./internal/ai/`.

## Deferred minors (triage before final merge — all non-blocking, in the ledger)
- Mobile: send-button bg-color branches raw `text` vs disabled `!text.trim()` (whitespace shows active); FormData hook test asserts type not file-entry; mealSlot table skips boundary hours 11/16/21; IdleAffordance 4-branch could split; camera-perm effect `[mode]`-only (not live-polled mid-session); source mapping only `ai_text` asserted e2e; resultSummary/totalLabel duplicate kcal-sum logic.
- Backend: alias-write failure in `foodlog.EditLog` swallowed (needs a logger injected into Service); `AddAlias` benign TOCTOU; openai_test `context.Background()` vs `t.Context()`; tautological `TestTranscribeCallTypeConst`; `internal/database` has no automated migration test.

## Keys (`api/.env`, gitignored)
`GEMINI_API_KEY` (free, verified). OpenAI-compat FREE fallback = NVIDIA: `OPENAI_API_KEY`=nvapi-…, `OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1`, `OPENAI_MODEL=meta/llama-3.3-70b-instruct`, `OPENAI_JSON_OBJECT=true`. `DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`. Local Postgres = pgvector/pgvector:pg15.

## Working agreements (this project)
- Flow: `superpowers:brainstorming` (creative) → `superpowers:writing-plans` → **`superpowers:subagent-driven-development`** (fresh implementer + spec/quality reviewer per task on sonnet; fix Critical/Important before moving on; final whole-branch review on opus). Use `.superpowers/sdd/progress.md` ledger + `scripts/task-brief`/`review-package` under the subagent-driven skill dir. Base for review-package = the commit before the task (NOT `HEAD~1`).
- Tell implementer subagents to run tests **FOREGROUND**. Stale RED LSP diagnostics after a task are normal (test-before-impl) — verify with a build.
- Go: `go test -race -p 1`, DB tests skip w/o Postgres, set `TEST_DATABASE_URL`. Mobile: `npx tsc --noEmit` + `npm test -- --ci`, RNTL v14 async `render`/`fireEvent`. `gofmt`/`vet` clean. Conventional single-line commits, no signature.
- Verify LLM model IDs against the live API, never training memory. Read live Expo v57 docs before native-module code.
- Push is outward-facing — confirm before pushing.
```

## Likely next moves (pick with the user)
1. Run the `/capture` fidelity review (the remaining gate) + fix any visual defects.
2. Wire the mobile Home "Snap a meal / tell Otto" hero + camera icon to `/capture` (currently only the tab button routes there).
3. Provide the eval golden dataset → run the Phase 2 exit-gate A/B (Gemini vs NVIDIA).
4. Address deferred minors / open a separate Phase 3 PR if PR #5 should stay Phase-2-only.
