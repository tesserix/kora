---
quick_id: 260820-pdi
slug: plandial-invisible
date: 2026-08-20
refs: kora#270, kora#238, kora#271
---

# PlanDial renders nothing, and has never rendered anything

Fixes #270.

## The mechanism

`src/components/instrument/PlanDial.tsx:119` sizes its `<Svg>` with
`width="100%"`. Its parent — the `AuthScaffold` header column in
`app/onboarding.tsx:302` — sets `alignItems: "center"`.

A centre-aligned cross axis gives children no width to be 100% *of*:
`PlanDial`'s root `<View>` shrinks to its content, the content is an `<Svg>`
asking for 100% of an unconstrained width, and it resolves to **zero**.

`height` is explicit (`GAUGE_VIEW_H`), so 178pt of vertical space is still
reserved. That is why this survived — it reads as deliberate whitespace above
the kcal numeral rather than as a missing component.

For contrast: `GaugeDial.tsx:340` uses a fixed `width={GAUGE_VIEW_W}` and renders
correctly on Home; `TickRuler` also uses `100%` but sits in a full-width column.
`PlanDial` is the only one with both conditions.

## The fix is small. The second half of this task is not.

Give the `<Svg>` a real width — `width={GAUGE_VIEW_W}` matches `GaugeDial` and is
the obvious candidate. Confirm at both content sizes before settling on it: the
header column is centred, and a fixed-width child there behaves differently from
a stretched one.

**Then actually look at it.** Nobody has ever seen this component in its intended
place. The surrounding header was laid out around a 178pt void, so:

- Does the dial sit correctly relative to the numeral and "KCAL / DAY" beneath
  it, or was the spacing tuned to empty space?
- Does the needle point where the plan says it should? Drag a ruler and check
  the needle tracks — #271 just moved it onto a shared value, and that path has
  only ever been exercised against an invisible component.
- Does it look right at `accessibility-extra-large`, where everything around it
  grows and the dial (being an SVG with a fixed viewBox) will not?

Report what you find. **Fix only the width in this branch**; if the composition
around it needs work, that is a design change and belongs in its own issue with
before/after images.

## Do not regress the two things this component just gained

1. **#271's perf work.** Static tick geometry is hoisted to a module constant and
   the lit-state is driven from a shared value via `useAnimatedProps`. There is a
   render-count test (`__tests__/PlanDial.rebuild.test.tsx`) pinning
   `buildGaugeTicks` at 0 calls across a 20-step drag. It must stay at 0 —
   **run it and say so**, because a width change that reintroduced a re-render
   would be an easy thing to miss.
2. **Accessibility posture.** The gauge is deliberately `accessibilityElementsHidden` /
   `importantForAccessibility="no-hide-descendants"` — the target is announced
   once as text on the surrounding panel, and a screen reader must not read it
   twice. Keep that.

## Constraints

- **A green suite is NOT verification.** Screenshots at BOTH `medium` and
  `accessibility-extra-large`. This whole line of work exists because 1,729 green
  tests hid a rendering bug (#257).
- Everything else on the onboarding screen must be unchanged. The dial appearing
  will shift nothing — the 178pt was already reserved — so a `medium` diff should
  show the dial appearing **and nothing else moving**. Verify that specifically;
  it is the cheapest possible proof the fix is inert beyond its own component.
- Do not touch #273 (ruler end-label clipping) or #268 (gauge face size), both of
  which are live on nearby components.

## Acceptance

- The dial renders at both content sizes, in the space already reserved for it.
- `PlanDial.rebuild.test.tsx` still passes with 0 `buildGaugeTicks` calls.
- The needle is confirmed to track a ruler drag on device.
- A written read on whether the composition around it now needs work.
- Atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
