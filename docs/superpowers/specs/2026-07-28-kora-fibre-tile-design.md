# Fibre dashboard tile — design spec (Food Memory Phase 2b)

**Goal:** Show a fibre progress bar on the Home dashboard alongside protein/carbs/fat, so users can track fibre against a sensible daily goal.

**Base:** stacked on `food-memory` (retarget PR to `main` after PR #7 merges).

## Behaviour

A fourth **Fibre** bar appears in Home's `MacroBars` (below Fat), showing `consumed.fiber_g / goal` with the same SVG-gradient bar treatment as the other macros.

- **Consumed** is already returned by the dashboard (`dashboard.service.go` sums `consumed.FiberG`).
- **Goal is derived client-side** (no backend change): `fibreGoal(kcalTarget) = kcalTarget > 0 ? round(14 * kcalTarget / 1000) : 30`. This is the standard dietary guideline (14 g fibre per 1000 kcal), with a 30 g fallback so the bar never divides by zero or shows `/0` when the calorie target is missing.

## Changes

- **New pure helper** `src/lib/fibreGoal.ts`: `fibreGoal(kcalTarget: number): number` (as above). Unit-tested including the `0`/negative → `30` fallback.
- **New gradient** `fibre` in `GradientSet` (`src/theme/palette.ts`) — a teal distinct from the green/amber/blue macros and the lime/violet vitals:
  - light: `["#2DD4BF", "#0D9488"]` · dark: `["#5EEAD4", "#14B8A6"]`
- **`src/components/home/MacroBars.tsx`**: extend the `Macros` interface with `fib: number` and `fibGoal: number`; add `<Bar label="Fibre" value={macros.fib} goal={macros.fibGoal} gradient={gradients.fibre} />` after the Fat bar. (The existing `Bar` renders `macro-fill-fibre` testID automatically from the lowercased label.)
- **`app/(tabs)/index.tsx`**: extend the `macros={...}` prop passed to `KcalHero`/`MacroBars` with `fib: d.consumed.fiber_g, fibGoal: fibreGoal(d.targets.kcal)` (import `fibreGoal`). The `macros` object is only built when dashboard data `d` exists, so `d.consumed`/`d.targets` are safe.

## Scope

Home only — that is where `MacroBars` lives. Diary uses a different stat card (out of scope). No backend, no migration.

## Testing

- `fibreGoal`: `2000 → 28`, `2750 → 39` (38.5 rounds up), `0 → 30`, negative → `30`.
- `MacroBars`: renders a 4th "Fibre" bar with the `macro-fill-fibre` fill and the `Xg / Yg` label; existing 3 bars unchanged.
- Home (`app/(tabs)/__tests__/index.test.tsx`) stays green (its dashboard mock already provides `consumed`/`targets`; if `targets.kcal` is absent in the mock, the fallback keeps it rendering).

## Constraints (inherited)

Tokens-only styling (gradient from the theme). RNTL v14 `await render`. Single-line conventional commits, no signature, never `git add -A`.

## Out of scope (remaining Phase 2 specs)

Manual pins/favorites; usual-meal naming & editing.
