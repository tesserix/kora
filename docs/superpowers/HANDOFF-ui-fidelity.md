# Handoff — Kora UI Fidelity Pass

**Date:** 2026-07-24. Written to continue in a fresh session.

## Where the project stands

- **Spec:** `docs/superpowers/specs/2026-07-24-kora-build-design.md` (approved; now includes a **UI-fidelity GATE** in §5 Cross-cutting).
- **Shipped (all reviewed, both suites green):**
  - PR #1 — Phase 0 foundations (**merged to main**): Go monolith (config/httpx/database/auth/user), `/v1/me`; Expo app with theme tokens + AppText/Button/Card + Firebase sign-in.
  - PR #2 — Phase 1a core logging (branch `phase-1a-core-logging`): onboarding/TDEE, food search + logging, dashboard, water, seed of 61 AU foods.
  - PR #3 — Phase 1b hardening (branch `phase-1b-hardening`, stacked on 1a): resolve middleware, typed errors, per-user timezone, O(1) streak, etc.
- **Firebase:** project `kora-app-e6d38` is live. Web app registered, Email/Password enabled. `apps/mobile/.env` and `api/.env` are filled (gitignored). Demo account: `demo@kora.app` / `KoraDemo123!` (already onboarded).
- **Verified end-to-end on the iPhone 17 Pro simulator:** real Firebase token → Go verify → user provisioned (AU-first Sydney tz) → onboarding/search/log/water/dashboard all work.
- **Tooling:** `idb` CLI at `~/Library/Python/3.9/bin/idb` + `idb_companion` (homebrew) drive the sim (tap/type/describe-all). Booted sim UDID: `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`. Mobile jest script is `jest --ci --forceExit`; RNTL v14 `render()` is async; run tests FOREGROUND.

## The problem this pass fixes

The built RN screens do **not** match the high-fidelity mockups in `design-system/ui_kits/kora/`. Phase 1a deliberately built dependency-free MVP widgets (a flat progress *bar* instead of a circular ring, plain text rows instead of food tiles, no editorial headline/capture hero). The Home mockup's own comment says it must be a **"conversational, Otto-led feed, NOT a calorie-tracker dashboard"** — the current build is exactly the generic dashboard it warns against.

## Decisions (from the user)

1. **Scope:** fidelity-match **all primary screens** in one pass — Home, Diary, Progress, plus the onboarding + log flows.
2. **Process:** a permanent **UI-fidelity gate** (now in the spec §5) — every frontend phase is reviewed against its `ui_kits/kora` mockup screenshot before merge.

## Mockups to match (source of truth)

`design-system/ui_kits/kora/`: `HomeScreen.jsx`, `DiaryScreen.jsx`, `ProgressScreen.jsx`, `Onboarding.jsx`, `CaptureScreen.jsx` (the log/capture flow), `MealDetail.jsx`, and **`Chrome.jsx`** (shared: `StatusBar`, `TabBar`, `FoodTile`, `Sheet`, `ScreenHeader`). They compose `window.TesserixDesignSystem_275930` DS components — notably `CircularProgress`, `Icon` (Lucide names), `Avatar`, `Card`, `Badge`, `Stat`.

Key shared infra the RN app is MISSING and needs first:
- **`react-native-svg`** → a real `CircularProgress`/Ring (currently a flat bar in `src/components/Ring.tsx`).
- **Icon system** — mockups use Lucide icon names (`house`, `sparkles`, `camera`, `mic`, `utensils`, `book-open`, `chart-line`, `grid-2x2`, …). Use `lucide-react-native` (needs react-native-svg) or `@expo/vector-icons`.
- **`FoodTile`** — hued single-tone tile + centered icon (`oklch(0.93 0.06 <hue>)` bg, `oklch(0.5 0.12 <hue>)` icon).
- **Bottom `TabBar`** — glassy floating pill: Home / Diary / **center capture (sparkles) button** / Progress / More. The app currently has NO tab navigation (just stacked routes) — this is a navigation change (Expo Router tabs).
- **`ScreenHeader`** (overline + 28px bold title + right slot), **`Sheet`** (bottom sheet for MealDetail), **`Avatar`**.
- **Editorial type:** big accent headline on Home (`27px/800/-0.03em`, accent kcal span), overlines (11px, 0.09em, uppercase, muted), mono for numerals.

Home specifically = header (date + greeting + coach button + avatar) → editorial Otto headline → **capture hero** (primary button "Snap a meal or tell Otto…" + camera/mic) → compact **FuelStrip** (ring + kcal-left + macro dots) → **Today feed** of `FoodTile` meal rows with inline Otto notes + dashed "Add dinner" prompt.

## Placeholders (features not built yet)

- **Otto coaching copy** (Home headline/subtitle, inline meal notes) → tasteful STATIC copy for now (AI coach is Phase 6).
- **Capture hero / camera / mic / center tab** → navigate to the existing manual `/log` screen for now (real capture is Phase 3).

## Recommended approach for the new session

1. Read this file + the spec §5 gate + the `ui_kits/kora` mockups (start with `Chrome.jsx`, `HomeScreen.jsx`).
2. Decide the branch base: this stacks on the frontend from `phase-1a`/`phase-1b`. Likely branch from `phase-1b-hardening` (or main once PRs merge) — confirm with the user.
3. Use `superpowers:writing-plans` → a "Phase 1c UI fidelity" plan: **Task 1 shared infra** (react-native-svg + icons + Ring/CircularProgress + FoodTile + TabBar + ScreenHeader + Sheet + Avatar + editorial type helpers), then one task per screen (Home, Diary, Progress, Onboarding, Log) each matched to its mockup with an idb screenshot review against the mockup.
4. Execute `superpowers:subagent-driven-development` (per standing preference). Tell subagents to run tests FOREGROUND. After each screen, screenshot the sim via idb and compare to the mockup as the review gate.

## Running services (may still be up from prior session; restart as needed)

- API: `cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' FIREBASE_PROJECT_ID='kora-app-e6d38' go run ./cmd/api` (needs docker-compose Postgres + `go run ./cmd/migrate` + `go run ./cmd/seed`).
- Metro: `cd apps/mobile && npx expo start --ios --port <free>` then `xcrun simctl openurl booted exp://127.0.0.1:<port>` if it doesn't auto-open.
