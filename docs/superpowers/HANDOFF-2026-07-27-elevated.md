# Handoff — Kora (2026-07-27, evening)

`main = 6a7b2e9` (pushed). Written to continue in a fresh session.

## Read first, in order
1. `.superpowers/sdd/progress.md` — the authoritative ledger (gitignored). Trust it + `git log` over recollection, especially after compaction.
2. This file.
3. The **approved, unbuilt** spec: `docs/superpowers/specs/2026-07-27-kora-elevated-dashboards-health-design.md`.
4. Prior handoff `docs/superpowers/HANDOFF-2026-07-27.md` (pre-redesign context).

## What shipped this session
- **iOS-native UI redesign — DONE, merged, live-verified.** 18 subagent-driven tasks (fresh implementer + reviewer each, opus whole-branch review) + a Phase-4 live sim pass, FF-merged to `main` (`2ed3e95..e557c50`, pushed) and branch deleted. Grouped iOS surfaces, SF type scale, SF Symbols, single **green** accent (purple gone), spring motion + haptics, light+dark, FoodTile/hue retired.
- **Live pass caught + fixed one Critical** (`e557c503`): `AnimatedNumber` called the JS `format()` on the reanimated **UI/worklet runtime** → crashed every animated-number screen. Jest can't catch it (mock NOOPs `useAnimatedReaction`) — **device-only bug class.** Fixed (format on JS thread), re-verified live on Home/Diary/Progress. **Lesson: always device-verify animated components.**

## Next up — APPROVED, NOT YET PLANNED
**Elevated dashboards + real Apple Health** (redesign v2). Spec approved by user. The merged redesign is correct-but-*stock* ("old iPhone / Settings screen"); this elevates the whole app to a premium wellness look **and** replaces fabricated metrics with real data.

- **Approved visual direction:** `scratchpad/kora-elevated.html` → artifact `https://claude.ai/code/artifact/5ada2418-8132-48ff-9d2d-affe55809841` (Home, Progress, Diary, Capture, Friends, Notifications; light+dark). Bold **filled gradient rings**, color per signal, `RingStat` mini-ring tiles, sparklines, `AreaTrend` weight chart, streak bars, depth + rhythm. Green stays hero.
- **Locked decisions** (in the spec): Apple Health via `@kingstinct/react-native-healthkit`, **client-only** read (no backend), **today's steps + last night's sleep**; **graceful "Connect Apple Health"** when unavailable (sim/denied/Android) — **NEVER a fabricated number** (hard invariant); fix fake "Avg intake" → real **7-day avg from logs** (client-side); **steps on Home** too.
- **Also true right now (must fix in this work):** Progress `steps`/`sleep`/`avg-intake` are **hardcoded fake strings** (`app/(tabs)/progress.tsx:122-125`; only Log streak is real). No Health integration or steps/sleep anywhere in the backend.

### THE NEXT STEP
Invoke **`superpowers:writing-plans`** to turn the spec into an implementation plan (5 phases: elevated primitive kit → core dashboards → capture+social+rest → Apple Health → live pass), then **`superpowers:subagent-driven-development`** on a fresh branch **`elevated-v2`** off `main`. Same working agreements as before.

## Working agreements (unchanged)
- Flow: brainstorming → writing-plans → **subagent-driven-development** (fresh sonnet implementer + sonnet reviewer per task; fix Critical/Important + re-review; opus final whole-branch review; one consolidated fix subagent). **Always subagent-driven, never ask inline** (user global pref). Fable-5 was the model when brainstorming; opus for final reviews.
- Each sub-project = own branch off `main`, spec+plan committed, FF-merged when the user says. Per-task review base = commit **before that task** (never `HEAD~1`). Use the skill's `scripts/{task-brief,review-package}`; hand subagents **files**, not pasted history. Ledger every task in `.superpowers/sdd/progress.md`.
- Mobile: `cd apps/mobile`; verify `npx tsc --noEmit` + `npm test -- --ci` **foreground**. Tokens-only in screens (hex only in `palette.ts`/`captureTheme.ts`). Preserve invariants when restyling: no-fabricated-nutrition, consent gates, mutation payloads, verbatim a11y labels — prove with **unmodified** payload/consent tests. Single-line conventional commits, no signature. **Never `git add -A`** (untracked `.idea/`). Stage explicit paths.

## Gotchas (environment)
- **Port 8081 is held by Docker** (`com.docke`), not Metro. Start Metro on **8091**: `RCT_METRO_PORT=8091 npx expo start --dev-client --port 8091`. Dev client → `exp+mobile://expo-development-client/?url=http://localhost:8091`.
- **Stale Metro cache** bites after big refactors (e.g. deleted-module "could not be found" redbox for code that's actually gone). Fix: restart Metro with `--clear`. The tree is fine if tsc + jest are green.
- Dev build on **iPhone 17 Pro** sim (`AD109A46-2F99-43C3-8AAA-FEE68DC8499E`), iOS 26.2. Rebuild for new native modules: `npx expo run:ios --device <udid>` (pod install picks them up). **Apple Health data does NOT exist on the sim** — Health features must degrade to "Connect" state there; real values need a physical device.
- Drive the sim with **idb** (`~/Library/Python/3.9/bin/idb`): `idb ui tap --udid <udid> X Y`; tap points = displayed_px × 1.31 ÷ 3. Screenshots: `xcrun simctl io <udid> screenshot out.png`. Dark toggle: `xcrun simctl ui <udid> appearance dark|light` (give RN a beat before screenshotting — the first shot can race the flip).
- Backend `/ready` on **:8080**; the demo user is authenticated and dashboard data flows (target 2,751 kcal). A stale firebase token can 1-off "Couldn't load your day" — a reload clears it.
- **GORM/GIP/etc.** — no backend work in this sub-project (mobile-only).

## Current live state (left running)
Metro `:8091` (fresh, `--clear`), backend `:8080`, dev build on the iPhone 17 Pro sim (appearance: light). Docker on 8081. Safe to kill/restart per the port-8091 recipe.
