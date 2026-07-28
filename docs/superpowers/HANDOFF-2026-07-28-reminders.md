# Handoff — Kora Meal Reminders + Food Memory Phase 2 (2026-07-28)

Continue in a fresh session. **Trust `.superpowers/sdd/progress.md` (the SDD ledger, gitignored) + `git log` over recollection.**

## IMMEDIATE TASK
Execute the **Meal Reminders v1** plan, subagent-driven, on branch **`reminders`** (already checked out, off `food-memory`).
- Plan: `docs/superpowers/plans/2026-07-28-kora-reminders.md` — **4 tasks, full code each.** Spec: `docs/superpowers/specs/2026-07-28-kora-reminders-design.md`.
- **Task 1 brief already generated:** `.superpowers/sdd/task-1-brief.md`. **Base for Task 1 = `8728f7d`** (plan commit, current HEAD).
- Per task (superpowers:subagent-driven-development): `scripts/task-brief <plan> N` → dispatch implementer (sonnet, foreground tests) → `scripts/review-package BASE HEAD` → review (read diff; dispatch reviewer for non-trivial) → fix Critical/Important → append one ledger line. Scripts dir: `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/`.
- Reminders = fixed per-meal times, on-device (`expo-notifications` daily local notifications + AsyncStorage prefs, NO backend). Tasks: 1 prefs · 2 buildSchedule+applyReminders · 3 useReminderPrefs hook + RemindersSection UI (adds `@react-native-community/datetimepicker` via `npx expo install`) + wire into `app/(tabs)/more.tsx` · 4 extend push.ts tap listener + reschedule-on-launch.
- **PLAN DEVIATION baked in:** `src/lib/push.ts` ALREADY registers ONE `addNotificationResponseReceivedListener` + `setNotificationHandler` — Task 4 EXTENDS that listener (branch on `data.kind==="reminder"` → `router.push("/capture")`), does NOT add a new one. Don't double-register.
- After 4 tasks: device-verify (set a reminder ~1-2 min ahead, confirm it fires + tap → capture), then finish → PR (base `food-memory`, stacked; retarget to `main` after #7 merges).

## BRANCH / PR STATE
- **`food-memory`** (HEAD `224b466`) — **PR #7, OPEN, awaiting USER merge.** Food Memory v1 + Phase-2a "Your usual" strip + hardening (dropped `?date=`, nil-guards, +tests) + fixes (themed MealRow in Log, `GestureHandlerRootView` at root, deterministic ID tiebreak). All reviewed, 331 mobile tests + Go `-race` green, device-verified.
- **`fibre-tile`** (HEAD `46fc6e1`) — **PR #8, OPEN, stacked on food-memory.** Fibre dashboard tile (client goal 14g/1000kcal, teal bar). Device-verified. **Retarget PR base to `main` after #7 merges.**
- **`reminders`** (HEAD `8728f7d`, CURRENT) — spec + plan committed, **NOT built**. Work here.
- `origin/main` = `8541060` (has elevated-v2; NOT yet food-memory).

## MERGE GATE (important)
`gh pr merge` is **BLOCKED by the Claude Code auto-mode classifier** — the assistant CANNOT run it; the USER must: `! gh pr merge 7 --merge --admin --delete-branch` (the `!` runs it in-session) or GitHub UI, or add a `gh pr merge:*` Bash permission rule. CI on the repo **fails environmentally** (GitHub Free: no WIF/org secrets; jobs die at setup in ~3s) — NOT a code signal; local test runs are the truth. Do NOT route around the merge gate (no direct push to main).

## ENVIRONMENT / GOTCHAS
- **Services are DOWN.** Restart when needed:
  - API: rebuild if code changed `cd api && go build -o /tmp/kora-api ./cmd/api`; run with env sourced (reads env directly, NO godotenv): `set -a && . /Users/Mahesh.Sangawar/personal/tesserix-new/kora/api/.env && set +a && /tmp/kora-api > /tmp/kora-api.log 2>&1 &` — needs DATABASE_URL etc. present. Health: `curl -s localhost:8080/health`.
  - Metro: `cd apps/mobile && npx expo start --dev-client --port 8091`.
- **idb IS available** at `/Users/Mahesh.Sangawar/Library/Python/3.9/bin/idb` (PATH-hidden; `which idb` fails). `idb ui tap --udid <udid> X Y`. Screen **402×874 pts @3x → tap point = displayed_screenshot_px × 0.437** (e.g. screenshots are 920×2000). Toast auto-dismisses in **5s** → **chain tap-food + tap-Undo in ONE bash command** (the read-gap between separate tool calls exceeds 5s). `xcrun simctl` has no tap; AppleScript accessibility is blocked; no Quartz — idb is the only tapper.
- **Sim** iPhone 17 Pro `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`, app `com.tesserix.kora`. Load fresh bundle: `xcrun simctl openurl <udid> "exp+mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8091"` (dev-client URL = no confirm dialog; plain `mobile://log` shows an "Open in mobile?" dialog → idb-tap Open at `(274,474)`). The center capture button goes to **/capture (Ask Otto), NOT /log**.
- **Two-dev-client ping-pong:** `com.mark8ly.admin` (light-theme "Merchant Admin" app) steals foreground via the shared scheme `"mobile"`. Fix: `xcrun simctl terminate <udid> com.mark8ly.admin` + `pkill -f "mark8ly/apps/mobile-admin.*expo start"`, then reload Kora.
- **Demo user** `demo@kora.app` = `146db1f1-62b4-4912-b7c4-3efd6301c0cc`, tz Australia/Sydney, seeded with repeated logs (eggs+oats breakfast, banana snack, chicken lunch) so memory sections populate. (`.env` `EXPO_PUBLIC_API_URL=http://localhost:8080`.)
- **Tests:** Go DB tests need `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable`, run `-race -p 1` FOREGROUND (Postgres via `infra/docker-compose.yml`; if a package errors on a missing column, run `TEST_DATABASE_URL=... go run ./cmd/migrate` — local DB drifts). Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` FOREGROUND; RNTL v14 → `await render`. Jest `--ci --forceExit` is intentional (RQ timer leak). Stale LSP "undefined" after adding Go/TS symbols is benign — verify via test/build.
- `gh` account = `mahesh-sangawar` (org access).

## WORKING AGREEMENTS
Subagent-driven execution ALWAYS (never ask inline-vs-subagent). No fabricated numbers (macros = item per-100g × grams, server-side; client sends only food_item_id+grams+slot+logged_at). User isolation every query. TZ via `LocFromContext`. Tokens-only mobile styling (MealRow/foodVisual/hslToHex; RN `Switch` themed). Single-line conventional commits, no signature, **never `git add -A`** (untracked `ios/`, `.superpowers/`, `docs/` exist — stage named files only). Device-verify native/animated at the end (jest can't catch worklet/native/notification behavior). Immutability, comprehensive error handling.

## AFTER REMINDERS — remaining Phase 2 (each own brainstorm→spec→plan→build)
- **Manual pins / favorites** (new pins table/endpoint + pin affordance + Pinned section).
- **Usual-meal naming & editing** (persisted meal overrides + edit screen — largest).
Also: retarget PR #8 to main after #7 merges.

## SUGGESTED OPENING PROMPT FOR THE NEW SESSION
> Continue the Kora build. Read first, in order: (1) `.superpowers/sdd/progress.md` (SDD ledger — the `=== MEAL REMINDERS v1 ===` section is live state; trust it + git log), (2) `docs/superpowers/HANDOFF-2026-07-28-reminders.md`, (3) plan `docs/superpowers/plans/2026-07-28-kora-reminders.md`. You're on branch `reminders` (HEAD 8728f7d). Execute the 4-task Reminders plan subagent-driven starting Task 1 (brief at `.superpowers/sdd/task-1-brief.md`, base 8728f7d), then device-verify → PR. Honor all working agreements + the push.ts extend-not-add-listener deviation. PR #7 (food-memory) awaits the user's manual merge (gh pr merge is classifier-gated); PR #8 (fibre-tile) retargets to main after.
