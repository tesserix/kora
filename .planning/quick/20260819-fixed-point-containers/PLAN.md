---
quick_id: 260819-fpc
slug: fixed-point-containers
date: 2026-08-19
refs: kora#173
---

# Two fixed-point containers that clip their own text at accessibility sizes

Both found by the kora#173 sweep. Both are pre-existing — neither was caused by
the leading fix (f99e2f79) or the Apple button fix (cc9ec6b3); those two fixes
made them visible by letting text reach its correct size.

**Two atomic commits, in this order.** Task B is the urgent one but Task A is
the riskier change, so land B first and keep them separately revertable.

---

## Task A — water quick-add pills wrap mid-number (HIGH, actively misleading)

`apps/mobile/src/components/diary/DayTotalCluster.tsx` — pill at ~:43
(`flex: 1`), label at ~:55.

At `accessibility-extra-large` "+250 ml" renders as **"+25" / "0 ml"** and
"+500 ml" as "+50" / "0 ml". Verified in `shots/23-diary-xl.png`.

This is not a cosmetic defect. The control **misstates its own quantity**: it
reads as +25 and +50 while adding 250 and 500. A user increasing their text size
for readability gets a water tracker that lies about what it logs. Correct at
`medium` (`shots/31-diary-med.png`).

The label has no `numberOfLines` and nothing to stop the wrap.

**Fix direction (decide from what the screen actually needs):** a quantity like
this must never wrap mid-number. Options are to keep it on one line and let it
shrink (`numberOfLines={1}` plus `adjustsFontSizeToFit`/`minimumFontScale`), to
cap the label's growth with `maxFontSizeMultiplier` the way primary controls
elsewhere in the app do (1.6 is the established ceiling), or to let the pills
stack vertically so each gets full width. Prefer whichever keeps the number
atomic AND legible — silently shrinking to 8pt is not a win either. Screenshot
the result; do not reason about it.

Check whether the same pattern affects any sibling readout in this file.

---

## Task B — TickRuler's graduations are clipped away entirely (HIGH)

`apps/mobile/src/components/instrument/TickRuler.tsx:462` — the outer container
is `height: HEIGHT + READOUT_HEIGHT` (64) with `overflow: "hidden"`.

The readout was previously fixed for its own clipping (`minHeight`, ~:482) and
that fix holds — "30 years" / "170 cm" / "70 kg" render fine. But the PARENT is
still a hard height. At XL the 15pt readout scales to ~40pt and consumes the
box, pushing the 44pt SVG tick scale out of it. Result: **every graduation is
gone and the number labels are sliced through the middle.** Verified in
`shots/13-onb1-xl-s2.png`; clean at `medium` (`shots/07-onb1-med.png`).

Age, height, weight and goal weight are ALL set by this control during
onboarding. It still drags, so it is not dead — but its scale is unreadable,
which is most of what the control is for.

**Handle with care.** This component had recent performance work (kora#176 moved
the drag onto the UI thread, kora#245 redrew graduations as two paths). Do not
undo either. The fix should be about the container's height/overflow, not about
the drag or the draw path.

Also note `src/theme` has no scaled-spacing helper — if the container height
needs to track the readout, derive it rather than hard-coding a second constant.

**Out of scope, file don't fix:** `TickRuler.tsx:513` (`fontSize={9}`) and
`:638` (`fontSize={10}`) are `SvgText`, which sits outside Dynamic Type
entirely — those labels never scale at any text size. That is a real finding
(#6 in the sweep) but a different, larger change. Leave it.

---

## Constraints

- **A green suite is NOT verification.** kora#173 exists because 1,729 green
  tests hid a rendering bug. Every claim needs a screenshot at BOTH `medium` and
  `accessibility-extra-large`.
- `medium` must be unchanged for both fixes — compare against the reference
  shots. A fix that improves XL by shifting `medium` is not done.
- Do not fix sweep findings #3–#8. They are being written up separately.

## Acceptance

- Water pills show a whole, unwrapped quantity at XL, legibly.
- TickRuler graduations are visible at XL, readout still uncut.
- `medium` visually unchanged for both.
- Two atomic commits, single-line conventional messages, NO signature and NO
  Co-Authored-By trailer (project convention).
