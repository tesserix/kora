# Kora — Elevated Dashboards + Real Apple Health

**Date:** 2026-07-27
**Status:** Approved design (mockup + decisions), pre-plan
**Builds on:** the merged iOS-native redesign (`main` @ e557c50) and its spec `2026-07-27-kora-ui-redesign-design.md`. This is **redesign v2**: same iOS bones and green brand, elevated to a premium wellness aesthetic, plus real Health data.
**Mockup (approved):** `scratchpad/kora-elevated.html` → https://claude.ai/code/artifact/5ada2418-8132-48ff-9d2d-affe55809841 (Home, Progress, Diary, Capture, Friends, Notifications; light+dark).

## Problem

The shipped redesign is *correct* iOS but landed on the **stock-Settings aesthetic**: flat cards, a thin empty ring, skeletal macro bars, one green on gray, and large blank areas. The user's words: "still doesn't look that good, like an old iPhone app." Separately, Progress displays **fabricated** numbers — "Avg steps 8,240", "Avg sleep 7.1 hrs", "Avg intake 1,921" are hardcoded — which contradicts the app's core no-fabricated-numbers principle (the entire nutrition engine is built on never inventing values).

## Goal

Elevate the whole app to a modern, premium wellness look — bold **filled gradient rings**, **color per signal**, richer tiles with mini-visualizations, sparklines, depth, and spacing rhythm — and replace every fabricated metric with **real data**: Apple Health (steps + sleep, client-only) and a real 7-day average intake. Light + dark. **Green stays the hero.** No backend changes; mobile-only.

## Decisions (locked with user)

1. **Visual direction:** the approved mockup. Green hero + supporting metric hues; depth over flatness; rings/sparklines/gradient fills over empty tracks.
2. **Apple Health:** `@kingstinct/react-native-healthkit`, **client-only read** (no backend, no sync, no new tables). **Today's steps** + **last night's sleep**.
3. **Graceful when Health is unavailable** (simulator, permission denied, non-iOS): steps/sleep show a tasteful **"Connect Apple Health"** state — **never a fabricated number**. Real values verify only on a physical device.
4. **Fix the fake "Avg intake"** → real **7-day average from logs**, computed **client-side** (no backend).
5. **Steps also on Home** (today's steps element under the hero).

---

## 1. Visual system (tokens + primitives)

### Token additions (`src/theme/palette.ts`)
- **Metric hues** (light/dark pairs): `steps` lime (`#8FD400` / `#B6FF3D`), `sleep` violet (`#7A6BFF` / `#8B7CFF`). Existing `accent`/`accentAmber`/`accentBlue` reused for calories/protein, carbs, fat.
- **Gradient stops** for the green ring: `greenBright #3DDC6E` → `greenDeep #12A150` (dark), tuned pair for light.
- **Elevation:** an elevated surface token + a real (not near-invisible) card shadow token; keep neutrals green-tinted.
- Helper `withAlpha` already exists for tinted fills; add gradient helpers as needed.

### Components (new + upgrades in `src/components/`)
- **`GaugeRing`** (upgrade `CircularProgress`): thick **filled gradient** arc, rounded cap, faint track, centered children, animated sweep from current→target. Powers the kcal hero and all mini-rings. Reduced-motion → static, **seeded to the settled value** (avoid the AnimatedNumber worklet-crash class — no JS fn on the UI runtime).
- **`MacroBars`** v2: colored **gradient** fills (green/amber/blue), rounded, animated width, gram labels tabular-nums.
- **`RingStat`** tile: dot+label, big value, meta line, right-aligned mini `GaugeRing`. Has explicit **states**: value / empty / **connect-Health**.
- **`Sparkline`**: small polyline trend (avg intake).
- **`AreaTrend`** (upgrade `WeightChart`): gradient **area fill** + line + emphasized endpoint dot; keeps the `>=2` guard + coordinate math + draw-in.
- **`StreakBars`**: filled bars for the streak count.
- **Elevated surfaces:** `Card`/tile gain depth (layered surface, real soft shadow, 24–30 radius, subtle top-gradient tint on hero cards). Still tokens-only, no raw hex in screens.
- **`MealRow`** v2: colored glyph chip (food-hued tint) + name/slot + kcal.
- **`LeaderRow`**: rank numeral, gradient avatar, name+sub, colored metric, "you" green-highlight — for Friends/Groups/Challenge standings.
- **`NotifRow`**: colored per-type icon chip + text + relative time + unread dot.
- **Segmented / tab bar / Sheet**: keep as-is (already good); tab bar stays the floating glass pill.

## 2. Per-screen application

Restyle-only where behavior exists — **preserve every invariant, payload, consent gate, and a11y label** (this is a visual pass like the first redesign).

- **Home** — hero `GaugeRing` (filled) with kcal-left inside + colored `MacroBars`; a **Steps-today** element (RingStat) below the hero; elevated meal card; "Log a meal" row.
- **Progress** — `AreaTrend` weight card + segmented range; 2×2 grid: **Avg intake** (real 7-day, Sparkline), **Log streak** (StreakBars, already real), **Steps** (RingStat, real Health), **Sleep** (RingStat, real Health).
- **Diary** — richer week strip (today = gradient pill), compact day-summary ring + Eaten/Left/Water, green water buttons, slot-grouped elevated meal cards. Swipe-to-delete + water payload + openMeal params unchanged.
- **Capture** — dark polish (gradient bg, spring bubbles, detected-food card with ring + colored macro chips + "Add all to diary", mode pills, composer). **Behavior/invariant/payloads untouched** (visual only).
- **Friends / Groups** — `LeaderRow` leaderboards, share-progress toggle, consent-safe "Not sharing" group. **Consent gate preserved** (metrics only for sharers).
- **Challenge** — `LeaderRow` standings, winner banner (trophy), Join/Leave/Delete flows unchanged.
- **Notifications** — `NotifRow` colored per-type icons, unread dots, relative time; deep-links + mark-read unchanged.
- **Meal / Log / More / Sign-in / Onboarding** — adopt the elevated cards/tiles/type for consistency; payloads/validation/firebase untouched.

## 3. Apple Health integration (client-only)

- **Library:** `@kingstinct/react-native-healthkit` (Expo config plugin, New Architecture). Adds `NSHealthShareUsageDescription` to Info.plist via the plugin. Requires a **dev-client rebuild** (new native module). iOS-only; Android/web are no-ops.
- **`useHealth()` hook** (`src/health/`): on mount requests **read** authorization for `stepCount` + `sleepAnalysis`; returns
  ```ts
  { status: 'authorized' | 'denied' | 'unavailable';
    steps: { today: number; goal: number } | null;
    sleep: { lastNightHours: number } | null; }
  ```
  - `today` steps = sum of `stepCount` samples for the device-local day.
  - `lastNightHours` = summed `asleep` category samples in the last-night window.
  - `unavailable` on non-iOS / simulator / no HealthKit; `denied` if the user declines.
- **Degradation (INVARIANT):** when `status !== 'authorized'`, the Steps/Sleep `RingStat`s render a **"Connect Apple Health"** affordance (tap → request auth, or deep-link to Settings if previously denied). They **never** show a number in that state. No fabricated values anywhere, ever.
- **No backend, no persistence, no sync.** Steps/sleep live only in the client view.

## 4. Real 7-day average intake

- Client-side: read the existing dashboard for the **last 7 local days** (React Query, cached per date), average `consumed.kcal` across days that have data. No backend or hook-contract change (reuse `useDashboard(date)`). If <1 day of data, show an empty/"—" state (not a fake number).

## 5. Architecture, testing, phasing

### Architecture
- New `src/health/` (hook + types + jest mock). New/upgraded components in `src/components/` and `src/components/{home,progress,diary,social,capture}/`. Token additions in `src/theme/palette.ts`. Screens restyled in place, preserving props/testIDs/a11y/payloads.
- **No `src/api/` or backend changes.**

### Testing & gates
- Unit-test new components incl. **all states** (value / empty / connect-Health); tokens; `useHealth` degradation by mocking `@kingstinct/react-native-healthkit` (authorized/denied/unavailable). Add its jest mock to `jest.setup.js`.
- Preserve invariants — proof tests must pass unmodified: no-fabricated-nutrition (capture/meal/log payloads), consent gates (Friends/Group leaderboards), meal PATCH / log createLog+client_log_ms / water noon-UTC / onboarding submit / firebase sign-in, verbatim a11y labels.
- Per task: `npx tsc --noEmit` + `npm test -- --ci` (foreground).
- **Live pass:** simulator for visuals + **degraded Health states** (sim has no Health → must show connect-prompt cleanly, never a number); **physical device** for real steps/sleep values. Device-verify every animated component (the worklet-crash class only surfaces on device).

### Phasing (branch `elevated-v2` off `main`)
1. **Elevated primitive kit** — tokens (metric hues, gradients, elevation) + `GaugeRing`, `MacroBars` v2, `RingStat`, `Sparkline`, `AreaTrend`, `StreakBars`, elevated `Card`, `MealRow`/`LeaderRow`/`NotifRow`.
2. **Core dashboards** — Home (hero + macros + steps element), Progress (AreaTrend + 2×2 grid), Diary.
3. **Capture + social + rest** — Capture polish, Friends/Groups/Challenge/Notifications, Meal/Log/More/Sign-in/Onboarding.
4. **Apple Health** — `@kingstinct/react-native-healthkit` + config plugin + dev-client rebuild, `useHealth`, wire Steps/Sleep RingStats + Home steps, real 7-day avg intake, degraded states.
5. **Live fidelity pass** — sim (visuals + degraded Health) + device (real Health), fix findings.

### Risks / notes
- **Health lib compat:** verify the Expo config plugin works on SDK 57 + New Arch; if not, fall back to `react-native-health` (older) or a thin custom native module — resolve in the plan's Phase-4 research step. Device-only regardless.
- **Restyle discipline:** heavy visual change across behavior-bearing screens — tokens-only, preserve payloads/consent/a11y, prove with unmodified invariant tests.
- **Performance:** more gradients/shadows — avoid heavy `backdrop-filter`/blur on scrolling content; keep shadows on static cards.
- The fidelity-gate memory now points at the redesign spec; this spec extends it (elevated visual system is the new bar).
