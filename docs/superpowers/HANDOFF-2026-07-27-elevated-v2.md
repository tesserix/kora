# Handoff — Kora `elevated-v2` (2026-07-27)

Continue in a fresh session. **Trust `.superpowers/sdd/progress.md` (the ledger) + `git log` over recollection.**

## Read first
1. `.superpowers/sdd/progress.md` — authoritative ledger (gitignored).
2. This file.
3. Plan: `docs/superpowers/plans/2026-07-27-kora-elevated-dashboards-health.md`.
4. Spec: `docs/superpowers/specs/2026-07-27-kora-elevated-dashboards-health-design.md`. Approved mock = artifact `5ada2418-8132-48ff-9d2d-affe55809841` (full CSS was fetched to `.../tool-results/artifact-5ada2418-*.html`).

## State
- Branch **`elevated-v2`**, pushed. **PR #6** open → base `main` (https://github.com/tesserix/kora/pull/6). HEAD ≈ `03e614c`.
- `gh` active account = **mahesh-sangawar** (personal) — the only one with tesserix org API access (the civica account SSH-pushes but can't open PRs).
- **282 jest tests green, tsc clean** as of the last full run (the entitlement/bundle-id commit is config-only). Dark mode is the default.
- **Done + live-verified on the sim:** full elevated redesign matching the mock (Home/Progress/Diary/Capture/Friends/Groups/Challenge/Notifications/Meal/Log/More + new Profile page); depth palette (green-tinted dark, no pure-black), radial gradient backdrop, full-width dark-glass dock w/ raised gradient camera; notifications bell + tappable avatar; back-nav on all pushed pages; **root-cause `PressableScale` fix** (was stacking all rows). Final opus whole-branch review passed (all invariants hold), findings fixed.
- **Phase 4 Apple Health — code-complete:** `src/health/useHealth.ts` (client-only HealthKit, honest 3-state, invariant: steps/sleep null unless authorized, lazy-required so a missing native module can't crash JS), `useAvgIntake7d` (real 7-day avg, skips empty days), wired into Home+Progress (connect/empty on sim). Android/Health-Connect seam noted (`TODO(health-connect)`), NOT implemented.

## IN FLIGHT — the crash + the running rebuild
- The first dev-client rebuild linked HealthKit but the app **crashed on launch (SIGTRAP/EXC_BREAKPOINT, native/pre-JS)** because the generated `ios/mobile/mobile.entitlements` was empty — the `@kingstinct/react-native-healthkit` plugin did **not** add the `com.apple.developer.healthkit` entitlement.
- **Fix committed (`03e614c`):** `app.json` `ios.entitlements` = `{ "com.apple.developer.healthkit": true, "com.apple.developer.healthkit.access": [] }`, and `bundleIdentifier` changed `com.unidevidp.mobile → com.tesserix.kora` (user request).
- **A clean rebuild is RUNNING in the background** (task `b7z3kqkco`; `ios/` was removed so prebuild regenerates with the entitlement + new bundle id): `RCT_METRO_PORT=8091 npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E`. Output: `<session tasks dir>/b7z3kqkco.output`. NOTE: `expo run:ios` stays attached to device logs and gets timeout-killed, but the **build itself completes** — look for `iOS Bundled … modules` in the output to confirm success.

## NEXT STEPS
1. **Verify the rebuild fixed the crash.** Metro on 8091 (see gotchas); launch the app (now `com.tesserix.kora`): `xcrun simctl launch AD109A46-2F99-43C3-8AAA-FEE68DC8499E com.tesserix.kora`, then load the bundle via the dev-client deep link, screenshot Home. Expect: no crash; Steps/Sleep show **"Connect Apple Health"** (sim has no Health data) — never a fabricated number.
2. **If it STILL crashes:** fallback = remove `@kingstinct/react-native-healthkit` + `react-native-nitro-modules` deps + the plugin (keep `useHealth` — it's lazy-guarded so it just reports `unavailable`/connect), rebuild → stable app; wire real Health in a dedicated device session. (The entitlement fix is the expected resolution; only fall back if it doesn't take.)
3. **Real steps/sleep** need a **physical iPhone** (sim has no Health data). Caveat: HealthKit never discloses read-grants, so authorized-but-no-access shows 0 — assess UX on device.
4. **Google Health (Android):** implement the Health Connect provider inside `useHealth` at the `TODO(health-connect)` seam (`react-native-health-connect`); same `{status,steps,sleep}` contract; needs an Android device to verify.
5. **Merge PR #6** when the user says (FF/squash into main).

## Deferred minors (non-blocking)
Progress streak reads "1 days" at streak=1 (pluralize); `person` Icon glyph iOS-only (Android→circle); layout correctness isn't unit-testable (jest renders Animated.View as plain View) — device-verify class.

## Environment gotchas
- Port **8081 = Docker**; run Metro on **8091**: `RCT_METRO_PORT=8091 npx expo start --dev-client --port 8091` (add `--clear` after big refactors). Dev-client deep link: `exp+mobile://expo-development-client/?url=http://localhost:8091`.
- Sim: **iPhone 17 Pro `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`**, iOS 26.2. App bundle id now **`com.tesserix.kora`**.
- Drive with **idb** (`~/Library/Python/3.9/bin/idb ui tap --udid <udid> X Y`), tap = displayed_px × 1.31 ÷ 3. Screenshot: `xcrun simctl io <udid> screenshot out.png`. Backend `/ready` on :8080 (demo user authed; target 2,751 kcal, no meals logged → hero ring empty is correct).
- **Native rebuild** (new native modules): `rm -rf apps/mobile/ios && RCT_METRO_PORT=8091 npx expo run:ios --device <udid>` (CNG regenerates `ios/`; ~15 min).
- CNG project — `ios/` is generated, not committed.

## Working agreements (unchanged)
Subagent-driven (fresh sonnet implementer + reviewer per task, fix Critical/Important + re-review, opus final whole-branch review; task-brief/review-package scripts; hand subagents files). Ledger every task. Tokens-only in screens (hex only in palette.ts/captureTheme.ts). Preserve invariants with **unmodified** proof tests: no-fabricated-numbers (Health/nutrition), consent gates, mutation payloads, verbatim a11y labels. Per task: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` foreground. Single-line conventional commits, no signature, **never `git add -A`** (untracked `.idea/`, `.superpowers/`, `ios/`). Always device-verify animated/native components (jest can't catch worklet-runtime or native crashes — this whole crash class is why).
