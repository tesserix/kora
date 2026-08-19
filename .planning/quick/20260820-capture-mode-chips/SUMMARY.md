---
quick_id: 260820-cmc
slug: capture-mode-chips
date: 2026-08-20
refs: kora#278
status: done
---

# The capture mode chips clipped TYPE off the screen — fixed

Two files changed. `apps/mobile/src/components/capture/ModePill.tsx` drops
`paddingHorizontal` from 16 to 12. `apps/mobile/app/capture.tsx` adds
`flexWrap: "wrap"` to the chip row. Nothing about the label changed.

## What was actually wrong

Measured with `idb ui describe-all` on iPhone 17 Pro Max — 440pt wide, 412pt
inner after the row's 14pt padding a side, so the box runs x=14..426.

**At `medium`** (the default, which is the part of the report that matters):

| chip | before x..right | width | after x..right | width |
|---|---|---|---|---|
| PHOTO | 14.0 .. 120.7 | 106.7 | 14.0 .. 112.7 | 98.7 |
| VOICE | 128.7 .. 231.7 | 103.0 | 120.7 .. 215.7 | 95.0 |
| SCAN | 239.7 .. 337.7 | 98.0 | 223.7 .. 313.7 | 90.0 |
| TYPE | 345.7 .. **441.0** | 95.3 | 321.7 .. 409.0 | 87.3 |

Row natural width **427.0pt against 412pt available** — 403pt of pills plus
3x8pt of gap. **The overflow is 15.0pt.** TYPE's right edge landed at x=441.0
on a 440pt display, so its 1pt right border was painted off the screen
entirely and the pill sat flush to the bezel with none of the 14pt padding the
other side gets. That is exactly the "loses its right border" in the report,
and the screenshot confirms it: the TYPE outline is open on the right.

After: the row is **395.0pt of 412pt**, one line, 17pt of headroom, TYPE's
right edge at 409.0 with a clean 17pt to the padding edge.

**At `accessibility-extra-large`** the same four chips measured 134.0 / 126.7 /
120.3 / 115.0 = 496pt of pills + 24pt of gaps = **520pt against 412pt, a 108pt
overflow**. TYPE started at x=419 — a 21pt sliver on screen, and **its tap
centre at x=476.5 was off the display**. That is not a clip, that is kora#276
again: a control that is neither visible nor hittable.

After, the row wraps to PHOTO / VOICE / SCAN (373pt of 412) on line one and
TYPE alone at x=14..121 on line two. Every chip whole, every chip inside the
padding box.

## Why padding *and* wrapping, and not the other levers

The arithmetic in the report was close but pessimistic: the real medium
overflow is 15pt, not ~48pt. That matters, because 15pt is cheap enough to buy
from padding alone — 4pt a side is 8pt a pill and 32pt off the row — and that
keeps all four chips on ONE line at the default size, which is the layout the
screen was designed around.

Wrapping is what handles the other end. 108pt at AXL cannot be recovered from
padding without gutting the control, and a horizontal scroll would hide a mode
selector by default, which the report rightly rules out. `flexWrap` spills only
the overflow, only when there is overflow, and it needs no `fontScale`
threshold the way `DayTotalCluster` (kora#260) does — the row simply stays on
one line until it cannot. `gap: 8` is both axes in React Native, so the wrapped
line arrives with its own 8pt of air.

**The label was not touched.** `letterSpacing: 1.4` at 13pt would have given
back roughly 11pt across the four labels — not enough to matter, and it is the
engraved instrument voice the spec asks for. Shrinking is ruled out on
principle: kora#263 showed a shrink box splitting "kg" into "k"/"g", and
"PHOTO" breaking mid-word on a mode selector is worse than the clip. A test now
pins `fontSize`, `letterSpacing`, and the absence of `adjustsFontSizeToFit` /
`numberOfLines` so that the next person short on width takes it from padding.

## The DetectedCard reuse — checked, and it is fine

`ModePill` is also the meal-slot chip in `DetectedCard` (BREAKFAST / LUNCH /
DINNER / SNACK). **That row already had `flexWrap: "wrap"`** — so this fix uses
the mechanism the component's other consumer had been using all along, and no
clip was ever possible there.

Reached on device (typed "One banana" through a real resolve) and measured both
ways inside the card's 374pt content box, x=33..407:

| | BREAKFAST | LUNCH | DINNER | SNACK | lines |
|---|---|---|---|---|---|
| before (pad 16) | 33..177 | 185..293.7 | 33..146.3 | 154.3..260.3 | 2 (2+2) |
| after (pad 12) | 33..169 | 177..277.7 | 285.7..391 | 33..131 | 2 (3+1) |

Same two lines, same card height, everything inside the box in both. The chips
just repack 2+2 -> 3+1 because each is 8pt narrower. Narrower pills in a row
that already wraps can only pack better; there is no width at which this change
introduces a clip DetectedCard did not already have.

## Verification

Frames are from `idb ui describe-all`, not from eyeballing the images.

**Visual** — screenshots at both content sizes, fresh launch for each (UIKit
reads the category at launch):

- `medium` before: TYPE's outline open on the right, pill flush to the bezel.
- `medium` after: four whole pills, TYPE closed and inset.
- `accessibility-extra-large` before: PHOTO / VOICE / SCAN and a 21pt sliver.
- `accessibility-extra-large` after: three on line one, TYPE whole on line two.

**Tappability, separately** — each chip tapped at its measured frame centre,
and the mode confirmed to have actually changed by reading the composer's
accessibility label back (`Quick photo capture` / `Hold to record` / `Scan a
barcode` / `Focus the message field`). Visible-but-unhittable was the kora#276
failure and is not assumed away here:

| | PHOTO | VOICE | SCAN | TYPE |
|---|---|---|---|---|
| medium | pass | pass | pass | pass |
| accessibility-extra-large | pass | pass | pass | pass |

**No regression at `medium` elsewhere** — the chip row's own y is unchanged at
824, the composer, viewfinder and header are unchanged in the before/after
frames, and only the four chip x/width values moved.

**Suite** — 207 files, 1808 tests, all passing. A green suite is not the
verification here; the measurements above are. The suite is noted only because
`ModePill.test.tsx` pinned `paddingHorizontal: 16` and had to be updated
deliberately rather than incidentally.

## Not touched

- kora#280 (tab-bar inset refactor).
- 4 pre-existing `react-hooks/refs` eslint errors in `app/capture.tsx`
  (lines 132, 146) — verified present on the unmodified baseline, out of scope.
- `.expo/types/router.d.ts` typecheck noise — generated file, pre-existing.

## Environment note

The throwaway account created to reach the screen was deleted through the app's
own delete-account flow. Simulator content size restored to `medium`.
