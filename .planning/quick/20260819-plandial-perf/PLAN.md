---
quick_id: 260819-pdp
slug: plandial-perf
date: 2026-08-19
refs: kora#238, kora#176, kora#245
---

# PlanDial rebuilds its gauge SVG on every reported ruler change

Fixes #238. Split out of #176, which moved the TickRuler drag onto the UI thread
but deliberately stopped at the ruler's own boundary.

## What still happens

`TickRuler` now wakes the JS thread only when a drag crosses into a new *step*
rather than every frame — a large reduction, but not zero. At `PX_PER_UNIT = 9`
a brisk drag crosses a step every 9px, and each crossing calls `onChange` →
`setState` in `app/onboarding.tsx` → a full re-render of the plan column:
`computePlan` (`:147`), `PlanDial` (`:311`), `Numeral` (`:312`),
`PlanDelta` (`:318`), `DerivationChain` (`:524`).

`PlanDial` is the expensive one and the one with no reason to re-render at all
during a drag. `src/components/instrument/PlanDial.tsx:32-33` calls
`buildGaugeTicks(fraction)` and `needleFor(fraction)` on every render, rebuilding
the whole tick array and re-creating every `<Line>` node.

**The dial's *fraction* changes during a drag. Its tick GEOMETRY does not.**

## Direction

1. **Memoize `buildGaugeTicks` against what actually changes its geometry**, not
   against `fraction`. Read `gauge.ts` first and establish what the tick array
   genuinely depends on — if `lit`/`red` per-tick flags are a function of
   `fraction`, then splitting static geometry from the lit-state is the point of
   the exercise, not an incidental detail.
2. **Drive the needle from a shared value with `useAnimatedProps`**, the way the
   ruler now drives its scale (#176), so a fraction change stops re-rendering the
   SVG tree.
3. **`useMemo` on `computePlan`** once the above is done — it is cheap
   arithmetic over a handful of numbers, but it is what makes the whole column
   re-render as a unit.

Do NOT change what the dial looks like. This is a pure performance change and
`medium`/AXL screenshots must be indistinguishable from `main`.

## Verification — read this carefully, it inverts today's usual rule

Most of this week's work could NOT be verified by jest, because the truth lived
in platform text layout. **This issue is the opposite.** The claim is
"`PlanDial` re-renders on every reported ruler change" — that is a JS-side fact
about React render counts, and jest is exactly the right instrument for it.

So: **write a render-count test.** Render the onboarding plan column (or PlanDial
directly with a changing `kcal`), drive N value changes, and assert the number of
`PlanDial` body executions / `buildGaugeTicks` calls. It should fail before the
fix and pass after. That test is the deliverable's proof, not a screenshot.

Screenshots are still required, but for a different job: proving the dial looks
**unchanged**. Take them at `medium` and `accessibility-extra-large` and compare
against `main`.

If you can also get a frame-timing or JS-thread measurement off a real drag,
that is a bonus — but do not block on it, and do not claim a speedup you did not
measure. "N renders became 1" is a complete and honest result.

## Constraints

- Do not undo #176's UI-thread drag or #245's two-path graduation drawing.
- Do not touch the Dynamic Type work merged today (#260, #263, #266, #267) —
  `TickRuler`'s label scaling in particular.
- `PlanDial`'s accessibility posture stays: the gauge is decorative and hidden
  from screen readers (`accessibilityElementsHidden`), because the target is
  announced once as text on the surrounding panel. Do not "improve" that.

## Acceptance

- A test that fails on `main` and passes here, pinning the render/rebuild count.
- Dial visually identical at both content sizes.
- Onboarding still drags smoothly — sanity-check by hand on the simulator.
- Atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
