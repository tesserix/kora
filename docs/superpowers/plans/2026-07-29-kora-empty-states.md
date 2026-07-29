# Kora Cold-Start Empty States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a brand-new Kora user (no logs, no weight) a guided first-run experience instead of bare zeros, on the three cold-start surfaces: Home, Diary, Progress.

**Architecture:** One reusable `EmptyState` presentational component (soft tinted icon tile + serif title + muted subtitle + optional CTA), consumed by the three tab screens behind their existing data conditions. No backend change — onboarding flow + Mifflin-St Jeor targets calc already ship; targets already render at zero-data, so the ring/targets stay and the empty guidance sits alongside.

**Tech Stack:** React Native + Expo (SDK 57 — read https://docs.expo.dev/versions/v57.0.0/ before writing native-touching code), TypeScript, existing mobile DS primitives (`AppText`, `Icon`, `PressableScale`, `GroupedSection`, `colors`, `spacing` from `@/theme`), Jest + React Native Testing Library.

## Global Constraints

- Immutability: no mutation; new objects only (per repo coding-style).
- Match existing component APIs — read the real file before using a primitive; do not invent props. Confirm `AppText` variants, `Icon` names, `colors`/`spacing` tokens against `apps/mobile/src/theme` and existing screens.
- UI-fidelity: no Kora mockup depicts empty states; design in the mockups' language (see `design-system/ui_kits/kora/*` — soft single-hue tinted tile + Lucide glyph, serif display, `Callout`-style nudges). Light + dark both correct.
- Accessibility: title/subtitle readable by screen reader; CTA has `accessibilityRole="button"` + label; honor reduced-motion (reuse existing `enter()` stagger pattern, which already no-ops on refetch).
- Tests run in the FOREGROUND (never background — they stall). Full mobile suite must stay green (`npm test`), `tsc` clean.
- Commit after each task, single-line conventional message, no signature.

---

### Task 1: `EmptyState` presentational component

**Files:**
- Create: `apps/mobile/src/components/common/EmptyState.tsx`
- Test: `apps/mobile/src/components/common/__tests__/EmptyState.test.tsx`

**Interfaces:**
- Produces: `EmptyState({ icon, title, subtitle, cta }: EmptyStateProps)` where
  `interface EmptyStateProps { icon: string; title: string; subtitle: string; cta?: { label: string; onPress: () => void } }`.
  Renders a centered soft-tinted circular icon tile (reuse the tile-tint approach used by food tiles — a low-alpha `colors.accent` fill), `AppText variant="title3"`-or-nearest for `title`, `AppText muted` for `subtitle`, and, when `cta` is present, a `PressableScale` button labelled `cta.label`. All copy comes from props (no hard-coded strings in the component).

- [ ] **Step 1: Read the primitives you'll use.** Open `apps/mobile/src/theme` (colors/spacing/AppText variants), `apps/mobile/src/components` for `Icon` + `PressableScale` signatures, and one existing composite (e.g. `home/PinnedStrip.tsx`) to copy layout idioms. Confirm exact `AppText` variant names and `Icon` name strings.

- [ ] **Step 2: Write the failing test.**

```tsx
import { render, screen, fireEvent } from "@testing-library/react-native";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("renders title, subtitle, and no CTA by default", () => {
    render(<EmptyState icon="camera" title="No meals yet" subtitle="Tap ✦ to log your first meal." />);
    expect(screen.getByText("No meals yet")).toBeTruthy();
    expect(screen.getByText("Tap ✦ to log your first meal.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a CTA and fires onPress", () => {
    const onPress = jest.fn();
    render(<EmptyState icon="scale" title="No weigh-ins" subtitle="Log your weight to see trends." cta={{ label: "Log weight", onPress }} />);
    fireEvent.press(screen.getByRole("button", { name: "Log weight" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.** Run (foreground): `npm test -- EmptyState` → Expected: FAIL, "Cannot find module '../EmptyState'".

- [ ] **Step 4: Implement `EmptyState.tsx`** using the confirmed primitives — centered column, tinted icon tile, title, muted subtitle, optional `PressableScale` CTA with `accessibilityRole="button"` + `accessibilityLabel={cta.label}`. No mutation; props only.

- [ ] **Step 5: Run test to verify it passes.** Run (foreground): `npm test -- EmptyState` → Expected: PASS (2 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit.** `git add apps/mobile/src/components/common/EmptyState.tsx apps/mobile/src/components/common/__tests__/EmptyState.test.tsx && git commit -m "feat(mobile): add reusable EmptyState component"`

---

### Task 2: Home first-run empty state

**Files:**
- Modify: `apps/mobile/app/(tabs)/index.tsx` (the meals section; keep the calorie ring/targets — they render fine at zero)
- Test: `apps/mobile/app/(tabs)/__tests__/index.test.tsx`

**Interfaces:**
- Consumes: `EmptyState` from Task 1.
- Condition: `!loadError && (logs.data ?? []).length === 0` → render `EmptyState` in place of the empty meals list. Ring + targets stay visible above it. CTA routes to capture: `router.push("/capture")` (confirm the capture route/param the ✦ button already uses in this file).

- [ ] **Step 1: Read** `app/(tabs)/index.tsx` meals-rendering block and its existing test to learn the data mocks + testID conventions.

- [ ] **Step 2: Write the failing test** — mock `useDashboard`/`useLogs` (match existing mock style) so `logs.data = []` and `dashboard.data` has targets; assert the Home empty copy renders and the ring/targets still show.

```tsx
it("shows first-run empty state when no meals are logged", () => {
  // arrange mocks: logs.data = [], dashboard.data.targets.kcal = 2000, not error
  render(<Home />);
  expect(screen.getByText("No meals logged yet")).toBeTruthy();
  expect(screen.getByText(/log your first meal/i)).toBeTruthy();
});
```

- [ ] **Step 3: Run to verify it fails.** `npm test -- "(tabs)/index"` → FAIL.

- [ ] **Step 4: Implement** — insert the `!loadError && loggedMeals.length === 0` branch rendering `EmptyState` (icon capture-glyph, title "No meals logged yet", subtitle "Tap ✦ to log your first meal.", cta → capture). Keep existing populated branch unchanged.

- [ ] **Step 5: Run to verify it passes** + `npx tsc --noEmit` clean + full suite `npm test` green.

- [ ] **Step 6: Commit.** `git commit -am "feat(mobile): home first-run empty state"`

---

### Task 3: Diary empty-day state

**Files:**
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (day timeline)
- Test: `apps/mobile/app/(tabs)/__tests__/diary.test.tsx`

**Interfaces:**
- Consumes: `EmptyState`. Condition: selected day has zero food logs → render `EmptyState` (icon "book"/timeline glyph, title "Nothing logged", subtitle "Meals you log on this day appear here.", no CTA — user is browsing a past/other day). Confirm the per-day logs variable in the file.

- [ ] **Step 1: Read** `diary.tsx` timeline block + its test.
- [ ] **Step 2: Write failing test** — mock empty day logs; assert "Nothing logged" renders.
- [ ] **Step 3: Run → FAIL** (`npm test -- "(tabs)/diary"`).
- [ ] **Step 4: Implement** the empty-day branch.
- [ ] **Step 5: Run → PASS** + `tsc` clean + full suite green.
- [ ] **Step 6: Commit.** `git commit -am "feat(mobile): diary empty-day state"`

---

### Task 4: Progress no-weight empty state

**Files:**
- Modify: `apps/mobile/app/(tabs)/progress.tsx` (weight chart area; the per-tile `state="empty"` for stats already exists — this adds the chart-level guidance)
- Test: `apps/mobile/app/(tabs)/__tests__/progress.test.tsx`

**Interfaces:**
- Consumes: `EmptyState`. Condition: `entries.length === 0` → render `EmptyState` in the chart area (icon "scale", title "No weigh-ins yet", subtitle "Log your weight to see your trend.", cta "Log weight" → open the existing weight-log sheet/route used elsewhere in this screen). Keep stat tiles' existing empty handling.

- [ ] **Step 1: Read** `progress.tsx` chart + weight-log entry point + its test.
- [ ] **Step 2: Write failing test** — mock `series.data = []`; assert "No weigh-ins yet" + CTA present.
- [ ] **Step 3: Run → FAIL** (`npm test -- "(tabs)/progress"`).
- [ ] **Step 4: Implement** the `entries.length === 0` branch with CTA wired to the existing weight-log affordance.
- [ ] **Step 5: Run → PASS** + `tsc` clean + full suite green.
- [ ] **Step 6: Commit.** `git commit -am "feat(mobile): progress no-weight empty state"`

---

### Task 5: First-run verification pass (targets render at zero data)

**Files:**
- Test only: `apps/mobile/app/(tabs)/__tests__/index.test.tsx` (add case)

**Interfaces:** No new code — locks the invariant that a brand-new user still sees their onboarding-computed targets (not blank) on Home.

- [ ] **Step 1: Write test** — dashboard has `targets` but `consumed.kcal = 0`, `logs.data = []`; assert the calorie goal/targets render (e.g. goal number present) alongside the Task 2 empty state.
- [ ] **Step 2: Run → PASS** (should already pass given Task 2; if it fails, fix the render condition so targets aren't hidden on empty).
- [ ] **Step 3: Commit.** `git commit -am "test(mobile): assert targets render on first-run home"`

---

## Self-Review

- **Spec coverage:** #42 remaining scope = empty states for dashboard/memory/insights/trends + first-run polish. Home (T2), Diary (T3), Progress/trends (T4) covered; memory strips already hide-on-empty (no work); insights screen isn't built yet (out of R1 scope) — noted, not a gap. Targets-persist verified (T5). ✅
- **Placeholder scan:** copy strings are concrete; primitive prop confirmation is an explicit Step-1 read per task (not a placeholder — the exact APIs live in the files). ✅
- **Type consistency:** `EmptyStateProps` used identically in T2–T4. ✅
