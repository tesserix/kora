# Kora Mobile UI Redesign — iOS-Native

**Date:** 2026-07-27
**Status:** Approved design, pre-plan
**Supersedes:** `design-system/ui_kits/kora/*.jsx` as the mobile fidelity reference. From this spec onward, the fidelity gate for mobile UI is **this document**, not the ui_kits mockups.

## Problem

The current mobile UI reads as templated AI output: default AI-purple (`#6b55df`), bordered white cards on a white canvas, pastel hue-tiles with keyword icons, sparkle iconography, ad-hoc 14–15px typography, and near-zero motion. It resembles existing trackers (MyFitnessPal et al.) and feels like a web app rendered on a phone.

## Goal

Redesign every screen so Kora feels like Apple built it: iOS-native structure (large titles, grouped inset lists, materials), the real SF type scale, one confident accent, spring-physics motion, and haptic feedback — light + dark from the system setting. Pure presentation change: no API, data, hook, or invariant changes.

## Decisions (locked with user)

1. **Direction:** iOS-native Apple HIG.
2. **Accent:** fresh green; supporting data hues amber/blue (activity-rings logic). Purple removed entirely.
3. **Scope:** entire app, executed in phases on one branch.
4. **Schemes:** light + dark, following the system setting.
5. **Motion:** full native feel — springs, counters, staggers, gestures, haptics; reduced-motion respected.

---

## 1. Design language

### Canvas & surfaces

| Token (semantic) | Light | Dark |
| --- | --- | --- |
| `background` (screen canvas) | `#F2F2F7` | `#000000` |
| `card` (inset grouped surface) | `#FFFFFF` | `#1C1C1E` |
| `cardSecondary` (nested fill, e.g. inputs) | `#F2F2F7` | `#2C2C2E` |
| `label` | `#000000` | `#FFFFFF` |
| `secondaryLabel` | `#3C3C43` @60% | `#EBEBF5` @60% |
| `tertiaryLabel` | `#3C3C43` @30% | `#EBEBF5` @30% |
| `separator` (hairline) | `#3C3C43` @29% | `#545458` @60% |
| `accent` | `#34C759` | `#30D158` |
| `accentAmber` (carbs/data) | `#FF9500` | `#FF9F0A` |
| `accentBlue` (fat/data) | `#007AFF` | `#0A84FF` |
| `destructive` | `#FF3B30` | `#FF453A` |

- Cards have **no borders**. Separation comes from background contrast (iOS grouped style). Hairline separators (`StyleSheet.hairlineWidth`) only inside grouped lists, inset to content edge.
- Card corner radius **12**; sheets 24 top corners; capsules `9999`.
- Screen horizontal margin **16** (iOS standard); 4pt spacing grid.
- Text is never tinted; the accent appears only on interactive/emphasis elements (buttons, active states, rings, links).
- Data hues (amber/blue) appear **only** in charts, rings, and macro visualizations — never on chrome.

### Typography (system font, real iOS scale)

| Role | Size/Weight | Tracking | Use |
| --- | --- | --- | --- |
| LargeTitle | 34 / 700 | −0.4 | Screen titles |
| Title1 | 28 / 700 | −0.4 | Hero headings (onboarding) |
| Title2 | 22 / 700 | −0.3 | Section leads, sheet titles |
| Headline | 17 / 600 | 0 | Row titles, buttons |
| Body | 17 / 400 | 0 | Body copy |
| Subheadline | 15 / 400 | 0 | Secondary row text |
| Footnote | 13 / 400 | 0 | Meta, timestamps |
| Caption | 11 / 500 uppercase | +0.5 | Section headers in grouped lists |

- Hero numerals (kcal-left, weight, scores): **SF Rounded** via `fontFamily: "ui-rounded"` (iOS), bold, `fontVariant: ["tabular-nums"]`.
- All counters/tabular data use `tabular-nums`.
- The existing `Overline`/`Numeral` components are re-based onto this scale; ad-hoc inline font sizes in screens are replaced by the scale.

### Icons

- **`expo-symbols`** (real SF Symbols) for chrome, tabs, list rows, actions — hierarchical rendering, weight-matched to text. Lucide retained only where no SF Symbol fits (audited case by case, e.g. barcode frame art).
- No sparkle/glitter iconography anywhere. AI capability is expressed by the capture experience itself.
- `Icon.tsx` grows a symbol-first path: SF Symbol name with lucide fallback, single component API so call sites stay uniform.

### Navigation chrome

- Large-title headers collapsing to an inline blurred bar on scroll (native `headerLargeTitle` on the stack where possible; otherwise a shared collapsing header with `expo-blur`).
- Tab bar: floating pill retained, refined — blur material, SF Symbols, green active tint, spring on selection, selection haptic. Center capture button unchanged in role.
- Sheets: grabber + detents everywhere (Sheet v2, §2).

### Theme architecture

- Mobile **stops consuming** the generated web tokens (`src/theme/tokens.ts`, exported from `design-system`). The mobile theme becomes hand-authored iOS-semantic tokens (table above) with light/dark pairs, resolved by `useTheme()` from the system color scheme. The generated file and its export script remain for web; mobile no longer imports it.
- `useTheme()` keeps its current API surface where practical (`colors`, `spacing`, `radius`, `fonts`, `shadows`) so restyles are mechanical; new keys added (`labels`, `type` scale helpers).
- `captureTheme.ts` merges into the main dark palette (capture uses the same tokens as dark mode + its own few extras).

## 2. Motion & feel system (`src/motion/`)

Small reusable kit; screens compose it — no bespoke per-screen animation code.

- **`springs.ts`** — two presets mapped from Apple's shipped values: `standard` (critically damped, response ≈ 0.35s) for all appearing/updating UI; `lively` (damping ≈ 0.8) only for gesture-released motion (sheet dismiss, flicks). Implemented as Reanimated spring configs.
- **`PressableScale`** — wraps `Pressable`; scales to 0.96 on touch-**down** instantly, springs back on release; optional `haptic` prop. Replaces bare `Pressable` opacity flips app-wide for tappable surfaces.
- **`AnimatedNumber`** — animates numeric text from current → new value (never from zero on refetch), tabular-nums, configurable formatter.
- **Ring/progress** — `CircularProgress` re-animated: sweeps from its current presentation value to the new target, interruptible.
- **Entrances** — standard `entering` presets (fade + 8pt rise, 30ms stagger) for list rows; **first mount only**, not on refetch.
- **`Sheet` v2** — spring-up presentation, grabber, drag-to-dismiss with velocity handoff (release velocity seeds the spring; velocity sign decides dismiss vs return), rubber-band above full height, scrim opacity tracks sheet position. Same component API (`visible`/`onClose`/children) so existing sheet call sites keep working.
- **`haptics.ts`** — thin wrapper over `expo-haptics`: `selection()` (tab switch, segmented controls, week strip), `impactLight()` (primary buttons), `success()` (meal/water/weight logged), `error()` (failed mutations). Fired on the causal frame only; no decorative haptics.
- **`useMotionPrefs`** — reads OS reduce-motion; when on: springs → short cross-fades, counters snap to value, staggers off, drag-dismiss retained (gesture, not animation), haptics stay.

**New deps:** `expo-haptics`, `expo-symbols` → one dev-client rebuild (`npm run ios`).

## 3. Per-screen redesigns

### Home
- Large title **"Today"**, date as subtitle; avatar top-right.
- **Remove** the fake-editorial headline and static Otto notes (no fabricated coach copy anywhere).
- Hero: large SF-Rounded kcal-left `AnimatedNumber` + animated ring; three macro bars (green/amber/blue) beneath with gram fractions.
- Meals: inset grouped list — row = meal name (Headline), slot + time (Footnote), kcal right-aligned tabular, chevron → meal sheet. Staggered entrance.
- Capture: center tab button remains primary; in-page hero card replaced by a final grouped row **"Log a meal"** (green plus in tinted squircle).
- Loading: skeleton shimmer on hero numbers (no 0-flash); error state keeps current copy in `destructive`.

### Diary
- Week strip: springy selection indicator, selection haptic, today dotted, loggable-day dots retained.
- Day summary card: Total / Remaining / Water with `AnimatedNumber`s.
- Timeline → grouped sections by meal slot (Breakfast/Lunch/Dinner/Snack caption headers). **Swipe-to-delete** on rows (gesture-handler swipe actions, destructive red, confirm-Alert flow intact).
- Water: `+250` / `+500` green capsules, fill feedback + success haptic.
- Empty day keeps "Copy from another day" CTA as a grouped row.

### Progress
- Large title "Progress". Weight hero: SF-Rounded current weight + delta badge (neutral on gain, per existing logic); chart path **draws in** with gradient fill; range toggle → iOS segmented control (selection haptic).
- Stats grid → grouped cards on the new tokens; streak = number + "day streak" (no emoji).
- Weight log sheet → Sheet v2.

### Capture
- Dark chat modality retained; restyled onto the dark token set (true black, green accent replaces indigo).
- Bubbles spring in (`standard`); waveform unchanged in behavior; DetectedCard → dark grouped card, SF Symbols, slot chips → segmented control; mode pills get segmented treatment + selection haptic; success haptic on add-to-diary.
- All capture behavior/tests (modes, error bubbles, add-all flow, invariant) unchanged.

### Meal detail + all sheets
- Sheet v2 chrome (grabber, spring, drag-dismiss).
- Stepper → iOS capsule `− 150 g +` with press-and-hold repeat; slot chips → segmented control; "Remove" as destructive grouped row; Save = green primary, disabled-until-dirty logic intact.

### Social screens (Friends, Groups, Group detail, Challenge, Notifications)
- All become iOS grouped-list screens: rows = avatar or SF Symbol in tinted squircle + name + detail + chevron.
- Leaderboards: ranked grouped rows, "you" row tinted green; "Not sharing" group quiet/tertiary.
- Notifications: unread dot in accent, relative timestamps, mark-read behavior unchanged.
- All existing consent/permission logic and copy untouched.

### More
- iOS Settings pattern: grouped sections; each row = colored-squircle SF Symbol + label + chevron (Friends, Groups, Notifications with unread badge); Share-progress toggle inline; Sign out as destructive red row.

### Sign-in / Onboarding
- Large-title forms; text fields = filled `cardSecondary`, no borders; green primary CTA above keyboard (`KeyboardAvoidingView`).
- Onboarding goal cards → selectable grouped rows with trailing checkmarks; numeric fields on the same field style; validation logic unchanged.

### Retired patterns
- `FoodTile` pastel hue-tile + keyword-icon system (and `hue.ts` tile colors) retired; meals render as clean rows. `foodVisual` mapping may survive only to pick an SF Symbol where a food glyph is genuinely useful.
- Bordered cards, dashed-border CTAs, tinted text, sparkle icons: all removed.

## 4. Architecture, testing, phasing

### Architecture
- `src/theme/` rewritten (hand-authored semantic tokens, light+dark); `src/motion/` new; components restyled **in place**, keeping props, testIDs, and accessibility labels so the existing 203-test suite survives with minimal churn.
- Behavior additions (swipe-to-delete, drag-dismiss, press-and-hold stepper) get new tests.
- **No data/API changes.** Hooks, invalidation keys, and the no-fabricated-numbers invariant untouched.

### Testing & gates
- Per task: `npx tsc --noEmit` + `npm test -- --ci` (foreground).
- Motion kit unit-tested including reduced-motion branches.
- **Fidelity gate: this spec** — final live sim review (iPhone 17 Pro dev build) of every screen in light **and** dark, motion and haptics verified by hand.

### Phasing (branch `ui-redesign` off main)
1. **Foundation** — tokens + theme rewrite, typography components, motion kit, `expo-haptics`/`expo-symbols` + dev-client rebuild, tab bar, Sheet v2.
2. **Core loop** — Home, Diary, Progress, Capture, Meal detail, Log-search.
3. **Social + entry** — Friends, Groups, Group detail, Challenge, Notifications, More, Sign-in, Onboarding.
4. **Live fidelity pass** — both schemes, fix findings, done.

### Risks / notes
- `ui-rounded` and SF Symbols are iOS-only; Android (not currently targeted — dev build is iOS) falls back to system sans + lucide via the Icon fallback path.
- Reanimated 4.5 `entering`/layout animations run on the New Architecture — already in use in this app's dev build.
- Jest: `expo-symbols` and `expo-haptics` need mocks in `jest.setup.js` (same pattern as existing expo module mocks).
- The `.claude` memory "UI fidelity gate = ui_kits/kora mockups" is superseded by this spec and must be updated when the redesign merges.
