# Fibre dashboard tile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Fibre progress bar to Home's macro bars, with a client-derived daily goal (14 g/1000 kcal).

**Architecture:** Pure client-side. A tiny `fibreGoal` helper derives the goal from the calorie target the dashboard already returns; `MacroBars` gains a 4th bar; Home wires the consumed/goal values through. No backend change.

**Tech Stack:** Expo/React Native + TypeScript + react-native-svg + Reanimated. Spec: `docs/superpowers/specs/2026-07-28-kora-fibre-tile-design.md`.

## Global Constraints

- **Goal formula:** `fibreGoal(kcalTarget) = kcalTarget > 0 ? Math.round(14 * kcalTarget / 1000) : 30` (14 g/1000 kcal guideline; 30 g fallback — never divide by zero).
- **Tokens-only styling:** the fibre bar uses a theme gradient (`gradients.fibre`), no hex literals in the component.
- **Testing:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci <file>` (foreground). Full suite: `npm test -- --ci`. RNTL v14 → `await render`.
- **Git:** branch `fibre-tile`. Single-line conventional commits, no signature. Stage only named files — never `git add -A`.

---

### Task 1: `fibreGoal` pure helper

**Files:**
- Create: `apps/mobile/src/lib/fibreGoal.ts`
- Test: `apps/mobile/src/lib/__tests__/fibreGoal.test.ts`

**Interfaces:**
- Produces: `function fibreGoal(kcalTarget: number): number`

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/lib/__tests__/fibreGoal.test.ts`:

```ts
import { fibreGoal } from "../fibreGoal";

test("14g per 1000 kcal, rounded", () => {
  expect(fibreGoal(2000)).toBe(28);
  expect(fibreGoal(2750)).toBe(39); // 14 * 2750 / 1000 = 38.5 -> 39
});

test("falls back to 30 when the calorie target is missing or non-positive", () => {
  expect(fibreGoal(0)).toBe(30);
  expect(fibreGoal(-100)).toBe(30);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/lib/__tests__/fibreGoal.test.ts`
Expected: FAIL — cannot find module `../fibreGoal`.

- [ ] **Step 3: Implement** — `apps/mobile/src/lib/fibreGoal.ts`:

```ts
// fibreGoal derives a daily fibre target from the user's calorie target using
// the standard dietary guideline of 14 g of fibre per 1000 kcal. Falls back to
// 30 g (a common general recommendation) when the calorie target is missing or
// non-positive, so callers never divide by zero or show a "/ 0" goal.
export function fibreGoal(kcalTarget: number): number {
  if (kcalTarget > 0) return Math.round((14 * kcalTarget) / 1000);
  return 30;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/lib/__tests__/fibreGoal.test.ts`
Expected: PASS (both) + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/fibreGoal.ts apps/mobile/src/lib/__tests__/fibreGoal.test.ts
git commit -m "feat(mobile): fibreGoal helper (14g per 1000 kcal)"
```

---

### Task 2: Fibre bar in `MacroBars` + Home wiring

**Files:**
- Modify: `apps/mobile/src/theme/palette.ts` (add `fibre` gradient to `GradientSet` + both schemes)
- Modify: `apps/mobile/src/components/home/MacroBars.tsx` (extend `Macros`, add Fibre `Bar`)
- Modify: `apps/mobile/app/(tabs)/index.tsx` (pass `fib`/`fibGoal`)
- Test: `apps/mobile/src/components/home/__tests__/MacroBars.test.tsx` (create if absent, or extend)

**Interfaces:**
- Consumes: `fibreGoal` (Task 1); `Macros` from `MacroBars`.

- [ ] **Step 1: Add the `fibre` gradient** to `apps/mobile/src/theme/palette.ts`. In the `GradientSet` type (currently `green/amber/blue/steps/sleep`), add:

```ts
  fibre: [string, string];
```

In `gradientStops.light` add `fibre: ["#2DD4BF", "#0D9488"],` and in `gradientStops.dark` add `fibre: ["#5EEAD4", "#14B8A6"],` (alongside the other entries).

- [ ] **Step 2: Write the failing MacroBars test** — `apps/mobile/src/components/home/__tests__/MacroBars.test.tsx` (create it; if it already exists, append the fibre test):

```tsx
import { render } from "@testing-library/react-native";
import { MacroBars } from "../MacroBars";

test("renders a Fibre bar with consumed/goal and its fill", async () => {
  const { getByText, getByTestId } = await render(
    <MacroBars macros={{ p: 40, c: 100, f: 20, pGoal: 160, cGoal: 356, fGoal: 76, fib: 18, fibGoal: 38 }} />,
  );
  getByText("Fibre");
  getByText("18g / 38g");
  getByTestId("macro-fill-fibre");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci src/components/home/__tests__/MacroBars.test.tsx`
Expected: FAIL — `macros` is missing `fib`/`fibGoal` (tsc/type error) and/or no "Fibre" text / `macro-fill-fibre` testID.

- [ ] **Step 4: Extend `MacroBars.tsx`.** In `apps/mobile/src/components/home/MacroBars.tsx`, add two fields to the `Macros` interface:

```ts
export interface Macros {
  p: number;
  c: number;
  f: number;
  pGoal: number;
  cGoal: number;
  fGoal: number;
  fib: number;
  fibGoal: number;
}
```

And add a fourth `Bar` after the Fat bar inside `MacroBars`:

```tsx
      <Bar label="Fat" value={macros.f} goal={macros.fGoal} gradient={gradients.blue} />
      <Bar label="Fibre" value={macros.fib} goal={macros.fibGoal} gradient={gradients.fibre} />
```

- [ ] **Step 5: Wire Home** — in `apps/mobile/app/(tabs)/index.tsx`, add the import:

```tsx
import { fibreGoal } from "@/lib/fibreGoal";
```

Then extend the `macros={...}` object passed to `KcalHero` (currently `macros={d ? { p: d.consumed.protein_g, c: d.consumed.carbs_g, f: d.consumed.fat_g, pGoal: d.targets.protein_g, cGoal: d.targets.carbs_g, fGoal: d.targets.fat_g } : undefined}` around line 145) to also include:

```tsx
                  fib: d.consumed.fiber_g,
                  fibGoal: fibreGoal(d.targets.kcal),
```

(i.e. the object becomes `{ p, c, f, pGoal, cGoal, fGoal, fib: d.consumed.fiber_g, fibGoal: fibreGoal(d.targets.kcal) }`.)

- [ ] **Step 6: Run tests + tsc**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci src/components/home/__tests__/MacroBars.test.tsx`
Expected: PASS + tsc clean.

- [ ] **Step 7: Full suite**

Run: `cd apps/mobile && npm test -- --ci`
Expected: PASS (all). If the Home test `app/(tabs)/__tests__/index.test.tsx` fails because its dashboard mock lacks `consumed.fiber_g` or `targets.kcal`, add those fields to that mock (fibre falls back to 30 if `targets.kcal` is absent, so only `consumed.fiber_g` needs a number) and stage that test file too.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/theme/palette.ts apps/mobile/src/components/home/MacroBars.tsx "apps/mobile/app/(tabs)/index.tsx" apps/mobile/src/components/home/__tests__/MacroBars.test.tsx
git commit -m "feat(mobile): fibre bar on Home dashboard"
```

(If you had to modify the Home test in Step 7, include `apps/mobile/app/(tabs)/__tests__/index.test.tsx` in the `git add`.)

---

## Device verification (controller, after all tasks)

On the sim (Metro `:8091`, demo user), open Home and confirm a **Fibre** bar renders below Fat in the macro card, with a teal gradient fill and a `Ng / Mg` label reflecting the seeded logs (fibre accumulates from logged foods). No layout break in the KcalHero card.

## Out of scope

Manual pins/favorites; usual-meal naming & editing.
