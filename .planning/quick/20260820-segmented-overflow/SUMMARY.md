---
quick_id: 260820-sgo
slug: segmented-overflow
date: 2026-08-20
refs: kora#288
status: done
---

# A layout fix for Settings, and a copy problem in Feedback that no layout fix can honestly solve

`apps/mobile/src/components/instrument/SegmentedGlass.tsx` gains
`paddingHorizontal: 8` on each segment and drops a `minimumFontScale` that was
never in force. Dynamic Type is **not** capped, because the measurement says
there is nothing to correct. Feedback's `"Something's broken"` still cannot fit
at AX3 and no layout change will make it — that one needs shorter copy, which is
a product call and is reported here rather than made.

## The measurement that decides the shape of the fix

kora#274 established that RN reads ONE multiplier from the content-size
category — the body ramp — and applies it to every authored size, while Apple's
ramp is per-text-style and compresses hard at display sizes. For `largeTitle`
that meant RN applying 2.643 where Apple applies 1.529, and the cap was a
correction toward platform behaviour.

**That finding does not transfer to an 11pt label.** Apple's ramp was read
straight out of UIKit on the target device rather than recalled — a Swift probe
calling `UIFont.preferredFont(forTextStyle:compatibleWith:)` across every
content-size category, compiled for `arm64-apple-ios26.0-simulator` and run under
`simctl spawn` on the iPhone 17 Pro Max (iOS 26.2). RN's multipliers are read
out of `react-native/React/CoreModules/RCTAccessibilityManager.mm`.

Normalised to `large`:

|          | L | xL | xxL | xxxL | AX1 | AX2 | AX3 | AX4 | AX5 |
|----------|---|----|-----|------|-----|-----|-----|-----|-----|
| Apple `caption1` | 1.000 | 1.167 | 1.333 | 1.500 | 1.833 | 2.167 | **2.667** | 3.083 | 3.583 |
| RN (all sizes)   | 1.000 | 1.118 | 1.235 | 1.353 | 1.786 | 2.143 | **2.643** | 3.143 | 3.571 |
| Apple `largeTitle` (for contrast) | 1.000 | 1.059 | 1.118 | 1.176 | 1.294 | 1.412 | **1.529** | 1.647 | 1.765 |

**RN is UNDER Apple almost everywhere and never more than 2% away.** At AX3 it
applies 2.643 against Apple's 2.667. There is no over-scale here to correct, and
a cap would put the label BELOW what iOS itself draws — precisely the cap
kora#268 rejected. Capping was ruled out on measurement, not taste.

The coincidence is worth stating plainly: RN's table happens to track Apple's
*caption* ramp closely while diverging wildly from Apple's *largeTitle* ramp.
kora#274's cap and this refusal to cap are the same principle applied to two
text styles that Apple treats very differently.

### What iOS's own segmented control does

Measured the same way, building a real `UISegmentedControl` inside a `UIWindow`
with `traitOverrides.preferredContentSizeCategory` set. The override is proven
live by a `.caption1` `UILabel` in the *same* window, which resolves 11 -> 12 ->
18 -> 22 -> 32 -> 43pt across M/L/xxxL/AX1/AX3/AX5.

In that same environment the segmented control's title labels resolve to a flat
**13.0pt** and its intrinsic height to a flat **31.0pt at every category from xS
to AX5**. `UISegmentedControl` does not participate in Dynamic Type at all.

That is a strong argument, and it cuts both ways, so it is not being followed.
Apple's answer is to freeze the control; Apple can also redesign the copy of
every caller. Freezing an 11pt label at 11pt is a real accessibility loss, so
this control keeps scaling and shrinks to fit when the copy is too long. The
trade is recorded in the component rather than left implicit.

## What was actually broken

Reproduced at AX3 on the iPhone 17 Pro Max, then measured two ways: segment
boxes from `idb ui describe-all`, glyph ink from column profiles of the 3x
capture.

The segment boxes were **correct** — 196.7pt each on Feedback, 120.3pt each on
Settings' appearance control. The flex layout was never the problem, and no ink
crossed a segment boundary. "Overflow" is not quite what happens:

- **The segments had no horizontal padding at all** (`paddingVertical: 7` only),
  so a label was entitled to fill its box wall-to-wall. On Feedback, `BROKEN`
  ended at x=216.3 and `I HAVE AN IDEA` began at x=223.0 — a **6.7pt** gutter,
  while the words *within* each label were separated by **11.3pt**. The gap
  between two different controls was smaller than the gap between two words in
  one of them, so the eye grouped `BROKEN I` before it grouped `I HAVE`. On
  Settings the three labels read as one run-on string, `SYSTEM LIGHT DARK`.

- **`minimumFontScale={0.85}` was never in force.** At AX3 the label's scaled
  size is 11 x 2.643 = 29.1pt. `SOMETHING'S BROKEN` rendered with a 10.7pt cap
  height — about 15pt, or **0.51** of the scaled size. RN's iOS `Text` ignores
  `minimumFontScale` and shrinks as far as it takes to fit. The declared floor
  was decoration; worse, Android *does* honour it, so the same control clipped
  on one platform where it shrank on the other.

## The fix

`paddingHorizontal: 8` on each segment, giving a 16pt gutter — an order above
the 1.4pt letter tracking, so word grouping wins. `minimumFontScale` drops
0.85 -> 0.5, the measured iOS floor, so the two platforms agree. Both numbers are
recorded in the component with the measurements they came from, as is the reason
not to cap Dynamic Type.

Measured at AX3, before -> after:

| | before | after |
|---|---|---|
| Feedback, gutter between the two labels | 6.7pt | **23.0pt** |
| Settings, gutter `SYSTEM`\|`LIGHT` | 20.7pt | **28.7pt** |
| Settings, `SYSTEM` rendered size | 28.7pt (99% of AX3, overflowing its box by 0.9pt) | 24.1pt (83%) |
| Settings, `LIGHT` / `DARK` | 28.7 / 28.2pt | unchanged |

Settings now reads as three distinct segments. The cost is that `SYSTEM` shrinks
where `LIGHT` and `DARK` do not — `adjustsFontSizeToFit` sizes each label
independently, so a control containing one label near its limit renders at two
different sizes. That unevenness is a symptom of a label at its limit, not a
separate defect; the uniform-size alternative is discussed under **Not done**.

## The part that is a copy problem, not a layout problem

`app/feedback.tsx` uses `{ label: "Something's broken" }`. At AX3 that label
needs **344.8pt** in a **196.7pt** half-track. Every lever fails:

- **Shrink** — it fits only at 15.1pt or below. AX3 asks for 29.1pt, so the user
  who turned text size up gets **52%** of what they asked for. Dynamic Type is
  silently switched off for that one label. Even at the 0.53 floor UIKit uses on
  its own segmented-control titles it still needs 199pt in 197pt.
- **Wrapping the label onto two lines** — the *longest single word*,
  `SOMETHING'S`, needs **212.9pt** on its own, still more than the 196.7pt
  available. There is no break point that helps.
- **`flexShrink` on segments** — ruled out by kora#263; a shrink box narrows past
  the word it holds.
- **Wrapping the row** — ruled out; a segmented control divides one track into N
  equal parts, and dropping a segment to its own line breaks the metaphor.

**So: no honest layout fix exists for this copy.** The padding change makes the
failure legible rather than disguising it — the two labels no longer collide,
and the size mismatch now plainly shows that one option's text is too long. The
fix is shorter copy (`Bug` / `Idea`, `Problem` / `Idea`, or similar). That is a
product decision and has deliberately **not** been made here. Settings' labels
(`SYSTEM`/`LIGHT`/`DARK`, `METRIC`/`IMPERIAL`) are all short enough and are
fully fixed.

## Verification

A green suite is not verification here, so: screenshots at both content sizes on
both affected screens, plus the golden comparator.

**`medium` — the golden comparator, run explicitly.** `settings`, `feedback` and
`onboarding` (the third `SegmentedGlass` route) all report **maxD 0, 0 pixels
over threshold, 0.000% faint — pixel-identical to the committed goldens**.
`tab-progress`, the fourth, is `ok` (maxD 6, 0 over threshold). This is the
expected result: the padding is symmetric around centred text, so it changes the
content box without moving the glyphs. **The goldens were not updated, because
nothing at `medium` changed.**

**Two caveats on that comparator run, both pre-existing and neither caused by
this change.**

1. *The committed goldens cannot be reproduced by the harness that judges them.*
   On an unmodified tree all 13 routes FAIL on an identical 243-pixel region at
   x 370..394, y 25..38 — the **battery glyph**. The goldens embed a
   `discharging` battery (white); `shots.mjs`'s `pinStatusBar` pins
   `--batteryState charged` (green + bolt), and that pin was already present at
   the commit the goldens were captured from (`ae575a1d`, per their manifest).
   Confirmed by rendering all three battery states and matching them against the
   golden crop. This is unrelated to `SegmentedGlass` — it fails identically on
   `about`, `ai-usage`, `coach`, `notifications`, `recipes`, `sign-in` and
   `tab-diary`, none of which use the component. To get a real signal the pin was
   temporarily pointed at `discharging`, re-captured, and compared; that harness
   change was **reverted** and is not in this commit. Someone should decide which
   state is correct and either fix the pin or re-capture the goldens — it is not
   this issue's call to make.

2. *`profile` and `tab-more` fail on the signed-in email.* The goldens were
   captured as `shotc1@kora.test`; this run used a throwaway account. The diff is
   exactly one line of text (bbox x 116..322 y 359..370 and x 123..316 y
   284..294) and nothing else. **Handoff: the simulator is now SIGNED OUT**, and
   the golden set needs `shotc1@kora.test` signed in again before the next
   `shots:compare` run, or those two routes will land on the sign-in wall.

**AX3 — screenshots before and after on both screens**, with ink geometry
measured off the 3x captures (the table above). Settings goes from a run-on
`SYSTEM LIGHT DARK` to three separated segments; Feedback goes from a 6.7pt
collision to a 23.0pt gutter.

**Suite:** 1817 tests / 207 suites pass. `tsc --noEmit` clean. `npx eslint`
clean on both changed files. (Prettier was not run — it is not this repo's
formatter.)

## Tests

`SegmentedGlass.test.tsx` gains three cases pinning what the bug turned on, each
carrying the measured number it came from: that every segment keeps horizontal
padding; that the label carries **no** `maxFontSizeMultiplier`, so a future
reader cannot quietly apply kora#274's cap here; and that the shrink floor
matches what iOS actually does.

## Not done, deliberately

- **Uniform label sizing across segments.** Making every label shrink to the
  longest one's factor would match `UISegmentedControl`'s coherence and remove
  the `SYSTEM`-smaller-than-`DARK` unevenness. It needs a two-pass
  `onTextLayout` measure-then-resize, which adds render churn to a control on
  four screens and risks exactly the class of regression the goldens exist to
  catch. Rejected as disproportionate to a symptom that disappears once the copy
  fits.
- **Capping Dynamic Type.** Measured out, see above.
- **Copy changes in `app/feedback.tsx`.** Product decision; reported, not made.
- **Re-capturing the goldens.** Nothing at `medium` changed, and re-baselining
  would bake the battery artefact in.

## Simulator state

Content size restored to `medium`; battery override restored to `charged` (the
state it was found in). Throwaway account `a11y288throwaway@example.com`
**deleted and confirmed deleted** — signing in with the same credentials that
worked minutes earlier now returns "Email or password is incorrect." Metro on
8083 stopped; 8081 and 8082 left running and untouched.
