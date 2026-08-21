---
quick_id: 260820-pdi
slug: plandial-invisible
date: 2026-08-20
refs: kora#270, kora#238, kora#271
status: complete
---

# PlanDial renders nothing — fixed

One-line change: `PlanDial`'s `<Svg>` went from `width="100%"` to
`width={GAUGE_VIEW_W}` (264). Everything else in the diff is a comment.

## Why "100%" resolved to zero

`app/onboarding.tsx:302` builds the `AuthScaffold` header as a column with
`alignItems: "center"`. A centre-aligned cross axis gives children no definite
width, so `PlanDial`'s root `<View>` shrinks to its content; the content is an
`<Svg>` asking for 100% of an undefined width, which resolves to 0. `height` was
explicit (`GAUGE_VIEW_H` = 178), so the vertical space stayed reserved and the
bug presented as deliberate whitespace above the kcal numeral. That is why it
survived from the component's introduction until now.

`GaugeDial.tsx:340` has always used the concrete `GAUGE_VIEW_W`; matching it is
the fix.

## Verification (iPhone 17 Pro Max, iOS 26.2, dev client, Metro :8083)

Reached onboarding pre-auth via sign-in > "Create an account" with a throwaway
account. All screenshots taken on fresh app launches (Fast Refresh corrupts
layout measurement on these components).

1. **Renders at `medium`.** Dial present, centred, needle at the plan value.
2. **Renders at `accessibility-extra-large`.** Present, centred, unchanged in
   size (fixed viewBox — see "Composition" below).
3. **`PlanDial.rebuild.test.tsx`: PASSES, 3/3.**
   - `does not rebuild the tick geometry when the target changes` — the test that
     pins `buildGaugeTicks` at **0 calls** across a 20-step drag. Still 0.
   - `keeps the same tick nodes across a run of target changes`
   - `the geometry it renders is not fraction-dependent`
   Full instrument folder: 10 suites / 124 tests pass. `onboarding`: 2 suites /
   36 tests pass. `tsc --noEmit` clean, `eslint` clean.
4. **Needle tracks a ruler drag — confirmed on device, both directions.** First
   real exercise of the path #271 added.
   - Weight 70 kg -> 92 kg: numeral 1957 -> 2298, needle swept clockwise from
     up-left to near-vertical, lit tick band grew with it.
   - Weight 92 kg -> 55 kg: numeral 2298 -> 1725, needle swept back
     anticlockwise, lit band shrank.
   Both match `needleFor` arithmetic on the (1200, 3600) scale: 1957 -> fraction
   0.315 -> -132 deg; 2298 -> 0.458 -> -100 deg; 1725 -> 0.219 -> -155 deg.
5. **Nothing else on the screen moved.** Pixel-diffed two fresh-launch
   screenshots at `medium` with identical app state and only the one-property
   change between them. Entire diff bounding box:

   ```
   (315, 278) - (1005, 706) px  =  (105, 93) - (335, 235) pt
   ```

   which is exactly the gauge's own footprint inside the already-reserved 178pt.
   Every other pixel is byte-identical. The fix is inert beyond its own component.

Simulator content size restored to `medium`. Throwaway account deleted through
the app's own `/delete-account` flow (reachable by deep link even mid-onboarding),
confirmed landing back on `/sign-in`.

## Composition: what it looks like now (reported, not fixed)

Per the plan, only the width changed. Findings for a separate issue:

- **At `medium` the composition is good.** The dial sits directly above the
  numeral with `spacing.xs` between them, and the arc's own internal bottom
  padding (hub at y=146 of a 178-tall viewBox, so ~32pt of empty SVG below it)
  reads as intentional breathing room. Needle, hub dot, numeral and "KCAL / DAY"
  stack on one vertical axis. The spacing was **not** tuned to empty space — it
  happens to land well.
- **At `accessibility-extra-large` it does not hold.** The dial is the only thing
  on the screen that does not grow, while the numeral roughly doubles. Two
  consequences:
  1. The dial reads as small relative to the numeral it labels — the numeral
     becomes the hero and the dial an ornament, inverting the intended hierarchy.
  2. The sticky header eats over half the viewport; the scroll region only
     reaches "Age" before the footer, so both ruler controls and the goal selector
     are below the fold. Pre-existing (the 178pt was always reserved) — the fix
     did not cause it, but it is visible for the first time.
- **Suggested follow-up (own issue, needs before/after images):** scale the gauge
  with `PixelRatio.getFontScale()`, or cap header height at AX sizes, so the
  instrument keeps its proportion to the numeral. Best done with #268 (gauge face
  size), live on the neighbouring component, which would otherwise fight it.

## Not touched

#273 (ruler end-label clipping) and #268 (gauge face size). The
`accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`
posture on the gauge wrapper is unchanged; the target is still announced once, as
text, by the surrounding panel.

## Other observations

- `PlanDelta` ("+147 KCAL FROM THAT CHANGE") appears on the first ruler change and
  pushes the rulers down ~34pt while the header is sticky, moving the drag target
  mid-interaction. Not a regression from this change.
- `idb ui text` truncation and the out-of-process "Use Strong Password?" sheet both
  bit during setup, exactly as the environment notes warned.
