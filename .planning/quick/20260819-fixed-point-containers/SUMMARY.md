---
quick_id: 260819-fpc
slug: fixed-point-containers
date: 2026-08-19
refs: kora#173
commits:
  - 201aaa93 # Task A - water quick-add pills
  - 394463e0 # Task B - TickRuler container
verified_on: iPhone 17 Pro Max (iOS 26.2), simulator, dev client
---

# Two fixed-point containers that clipped their own text — fixed and measured

Both defects reproduced, both fixed, both verified by screenshot at `medium` AND
`accessibility-extra-large`. The suite (1,763 tests, 202 suites) is green, but
per the plan's own constraint that is not what any claim below rests on.

---

## Task A — water quick-add pills (commit `201aaa93`)

`apps/mobile/src/components/diary/DayTotalCluster.tsx`

**Measured before** (`shots/23-diary-xl.png`): pills read `+25` / `0 ml` and
`+50` / `0 ml` — the control misstating its own quantity by a factor of ten.

**Measured after** (`fix/20-diary-xl-AFTER.png`): `+250 ml` and `+500 ml`, each
whole, on one line, at full legible size.

**Fix — three parts, each doing a distinct job:**

1. `numberOfLines={1}` on the label. The hard guarantee that the number stays
   atomic. Nothing shrinks the glyphs, so a quantity that still could not fit
   would truncate *visibly* rather than lie quietly.
2. `maxFontSizeMultiplier={1.6}` — the ceiling already used by FloatingTabBar,
   GaugeDial, WeekRail and ModePill for primary controls.
3. The pill row switches to `flexDirection: "column"` above `fontScale > 1.3`,
   so each pill gets the footer's full width instead of half of it. Without
   this, part 1 alone would have satisfied "atomic" by truncating — which the
   plan explicitly ruled out ("silently shrinking to 8pt is not a win either").

`WaterPill` drops `flex: 1` when stacked: in a column the default
`align-items: stretch` already gives full width, and `flex: 1` would instead
divide a height nothing asked for.

**Sibling readout checked, as the plan asked.** The `0.0 L` water readout is a
quantity in the same fixed row and would break to `0.0` / `L` once the value
reaches two digits, so it got the same `numberOfLines={1}` + 1.6 cap. The
`0 / 1,957 kcal` row was inspected and left alone — it is inside a `padding: 16`
block with the full card width and did not wrap at XL.

**Functional verification, not just visual:** tapped `+250 ml` at `medium`
(water `0.0 L` -> `0.3 L`) and the *stacked* `+500 ml` at XL (`0.3 L` -> `0.8 L`).
The relayout did not cost the pills their hit target, and the pills log what
they say.

---

## Task B — TickRuler graduations (commit `394463e0`)

`apps/mobile/src/components/instrument/TickRuler.tsx:462`

**Measured before** (`shots/13-onb1-xl-s2.png`): every graduation gone; only
sliced number labels remained, cut through the middle.

**Measured after** (`fix/18-onb-xl-up.png`): full minor and major graduations,
complete uncut labels (20/30/40/50, 150/160/170/180/190), orange centre index
correctly placed, readout (`30 years`, `170 cm`) still uncut.

**Fix — one word.** `height: HEIGHT + READOUT_HEIGHT` -> `minHeight: ...`.

This is the same correction the readout inside it already received in f99e2f79,
applied to the box that contains it: a hard height in unscaled points around a
first child that Dynamic Type scales. The ticks below are still a fixed 44pt and
the readout still cannot shrink, so the no-reflow guarantee the row exists for
survives intact.

`overflow: "hidden"` was deliberately kept — it exists for the HORIZONTAL clip
of the deliberately-oversized scale, and with an auto height there is nothing
left to clip vertically.

**Deliberately NOT done:**
- No fontScale-derived height. It would have had to be kept in step with the
  readout's own leading; a floor needs no such coupling. This also honours the
  plan's "derive it rather than hard-coding a second constant".
- kora#176 (UI-thread drag) and kora#245 (two-path graduations) untouched — the
  change is confined to one style property on the container.
- `SvgText` `fontSize={9}` / `fontSize={10}` left alone as out of scope.
- `DetentedRuler`'s `height: HEIGHT + 8` left alone: it has no RN `Text` child,
  only `SvgText`, which sits outside Dynamic Type entirely.

---

## "medium must be unchanged" — measured, not assumed

| Screen | Method | Result |
|---|---|---|
| Onboarding (Task B) | pixel diff vs `shots/07-onb1-med.png` | **`diff bbox: None`** — byte-for-byte identical |
| Diary (Task A) | pixel diff vs `shots/31-diary-med.png` | max per-pixel delta **43/255**, no layout shift |

The Diary diff is worth being explicit about rather than waving through. It is
NOT a layout change:
- Max channel difference is 43/255. Text moving on this near-black background
  produces near-255 deltas; there are none.
- The largest share of it (9,321 px) sits in the **WeekRail** — a component this
  change never touches — with the day-total and water footer showing the same
  low-amplitude signature.

That is the translucent red `ExpoLinearGradient` fallback overlay compositing
slightly differently between runs, not geometry.

---

## Environment note (worked around, not fixed)

The dev client on this simulator is stale and lacks `expo-linear-gradient`, so
affected screens render a red `Unimplemented component:
<ViewManagerAdapter_ExpoLinearGradient>` box. It is present in the reference
shots too, so before/after comparison stays valid, and it did not obscure either
target. Not a bug in this change.

## Pre-existing, left alone (scope boundary)

`eslint` reports 9 `react-hooks/immutability` errors in `TickRuler.tsx`, all
inside `useDragReport` (lines ~320-361). Confirmed pre-existing by linting the
file as it stands at `HEAD`: **also 9 errors**. Not touched.
`DayTotalCluster.tsx` lints clean.

## Verification trail

Simulator: iPhone 17 Pro Max, `8B6D805C-7155-4238-BFA6-DA7109C7DE84`.
A single throwaway account (`k173a@test.com`) covered both screens and was
**deleted through the app's own delete-account flow** at the end
(`fix/34-deleted.png` — returned to the sign-in screen). Content size restored
to `medium`.

## Note on commit order

The plan's prose contains a contradiction: the header says "Two atomic commits,
in this order" (A then B) while the following sentence says "land B first".
Committed A then B per the executing instruction. Both are independently
revertable either way, which is what that paragraph was actually protecting.
