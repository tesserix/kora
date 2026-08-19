---
quick_id: 260819-pdp
slug: plandial-perf
date: 2026-08-19
refs: kora#238, kora#176, kora#245
branch: perf/238-plandial
---

# PlanDial gauge rebuild — summary

Moved `PlanDial`'s needle position and lit-tick boundary onto the UI thread via a
shared value, so a reported ruler change no longer rebuilds the gauge's tick array
or re-creates its 41 `<Line>` nodes.

## Measured result

Instrument: jest, 1 mount + 20 reported `kcal` changes (what one brisk ruler drag
across `PX_PER_UNIT = 9` produces).

| Metric | main | perf/238-plandial |
| --- | ---: | ---: |
| `buildGaugeTicks` calls | 21 | 0 (1 at module load, amortized) |
| SVG `<Line>` renders (41 ticks + needle) | 882 | 42 (mount only) |
| Tick node identity across the 20 changes | new every change | same node |

That is the whole claim: **N rebuilds became 1**. No frame-timing or JS-thread
measurement was taken, so no speedup in milliseconds is claimed.

## What changed

- `src/components/instrument/gauge.ts` — exported `GAUGE_TICKS` (was a private
  `TICKS = 40` that `GaugeDial` duplicated as a literal `40`); documented that
  `.lit` is the only field of `buildGaugeTicks` that depends on `fraction`.
- `src/components/instrument/PlanDial.tsx` — tick geometry built once at module
  scope; each tick is a `memo`'d component whose only animated prop is `stroke`,
  computed from a `fractionSV` shared value on the UI thread; the needle rides the
  same shared value through `useAnimatedProps`; the whole `<Svg>` sits behind
  `memo` keyed on `hasTarget`.
- `src/components/instrument/GaugeDial.tsx` — the duplicated literal `40` now
  reads `GAUGE_TICKS`. Behaviour-identical.
- `src/components/instrument/__tests__/PlanDial.rebuild.test.tsx` — new.

Ticks gained `plan-dial-tick-{i}` testIDs so node identity is assertable.

## Direction items from the plan

1. **Memoize against what actually changes the geometry** — done. Established by
   reading `gauge.ts`: `x1/y1/x2/y2/width/major/red` are functions of module
   constants only; `fraction` reaches exactly one field, `lit`. So the split is
   static geometry (module constant) vs. lit-state (UI thread), which is what the
   plan anticipated.
2. **Drive the needle from a shared value** — done, matching `GaugeDial`'s
   existing `useAnimatedProps` pattern.
3. **`useMemo` on `computePlan`** — **already done on `main`.** `app/onboarding.tsx`
   wraps it in `useMemo` keyed on the seven inputs. No change was needed and none
   was made. The plan's reference to `:147` as an unmemoized call is stale.

## Deliberate non-changes

- **The needle does not spring.** `GaugeDial` springs because its value arrives
  from data; `PlanDial` follows a finger. It has always jump-cut, and adding
  motion under a perf fix would be exactly the visual change the plan forbids.
  The shared value is assigned directly.
- **Accessibility posture untouched** — the gauge stays
  `accessibilityElementsHidden` / `no-hide-descendants`, per the plan's constraint.
- **`planTickColor` is not `GaugeDial`'s `tickColorFor`.** The two dials colour
  their ticks differently on purpose (GaugeDial alpha-fades unlit-red and minor-lit
  ticks; PlanDial does not). Unifying them would have been a visual change.
- **`#176`'s UI-thread drag and `#245`'s two-path graduations untouched.** So is
  the Dynamic Type work (`#260/#263/#266/#267`) — `TickRuler` was not modified.

## Verification

- **Render-count test** (`PlanDial.rebuild.test.tsx`) fails on `main` (`Expected: 1,
  Received: 21`) and passes here. Committed separately as the RED gate.
- **Full suite:** 206 suites / 1802 tests pass. `tsc` clean apart from pre-existing
  noise in the generated `.expo/types/router.d.ts`. Lint clean on changed files.
- **Screenshots** (iPhone 17 Pro Max, prod API, fresh launch per capture):
  `medium` and `accessibility-extra-large`, `main` vs. branch — **0 differing
  pixels** at both sizes.

  Caveat worth stating plainly: on device the dial does not paint at all, on
  `main` or on this branch, because of a pre-existing `width="100%"` bug (see
  `deferred-items.md`). Comparing two blank gaps proves nothing, so both sides
  were re-captured with a **temporary, uncommitted** `width={GAUGE_VIEW_W}` edit
  applied identically to each. Those captures show the dial fully drawn — ticks,
  lit boundary, needle, hub — and are the ones that diff to zero. The temporary
  edit was reverted; the working tree carries no trace of it.
- **Drag sanity check by hand:** weight ruler swiped 70 -> 101.5 kg; target moved
  1957 -> 2445 kcal, needle swept and the lit-tick boundary advanced with it. This
  is the on-device proof that the shared-value path works under real reanimated,
  not just under the jest mock.

## Notes

- React Compiler is enabled in this app. It does not subsume this change: it would
  memoize `buildGaugeTicks(fraction)` on `fraction`, which is precisely the
  argument that changes on every step of a drag.
- A throwaway account (`pdp238@kora.test`) was created on prod to reach onboarding
  and was deleted through the app's own delete-account flow. Simulator content size
  restored to `medium`.

## Commits

- `74dce14` test(instrument): pin PlanDial's gauge rebuild count across target changes (#238)
- `8696e2c` perf(instrument): drive PlanDial's needle and lit ticks from a shared value (#238)
