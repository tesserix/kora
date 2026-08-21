---
quick_id: 260820-hha
slug: home-header-actions
date: 2026-08-20
refs: kora#276
status: done
---

# Home's bell and avatar are pushed off the right edge — fixed

One file changed: `apps/mobile/app/(tabs)/index.tsx`. One property added, one
stated: `flexShrink: 1` on the title column, `flexShrink: 0` on the actions row.

## What was actually wrong

Measured with `idb ui describe-all` on iPhone 17 Pro Max (440pt wide, 408pt
inner after the row's 16pt padding) at `accessibility-extra-large`, on Home:

| | title column | bell | avatar |
|---|---|---|---|
| before | 408pt (x=16..424) | **x=424..464** | **x=476..516** |
| after | 316pt (x=16..332) | x=332..372 | x=384..424 |

The screen is 440pt. Before the fix the bell's **tap centre was at x=444, four
points past the right edge**, and the avatar sat entirely off-screen from 476.
Only a 16pt sliver of the bell was ever painted — which is exactly why this
reads as a rendering artefact in a screenshot rather than as two controls the
user cannot reach.

React Native defaults `flexShrink` to **0**, where the web defaults to 1. Both
children of the header row therefore held their hypothetical width: the title
column wrapped to fill the full 408pt inner width and claimed all of it, the
actions claimed 92pt (40 + 12 gap + 40), the row overflowed by 92pt, and
`justifyContent: "space-between"` cannot reclaim space that does not exist — so
the whole overflow went off the right edge.

At `medium` the same two columns measure 228 + 92 of 408. No overflow, so
nothing shrinks and nothing moves.

## This is kora#266 inverted, not repeated

In `ScreenHeader` (kora#266) the title column had `flex: 1` and collapsed
**below its own content** while a bare sibling kept `flexShrink: 0`. Here the
title column had **no** flex constraint at all and collapsed below nothing —
the opposite failure from the opposite cause.

The fix is `flexShrink: 1`, deliberately **not** `flex: 1`. `flex: 1` also sets
`flexGrow: 1` and `flexBasis: 0`, which is the combination kora#266 had to
undo: the column would be sized from whatever the actions left over with no
floor, and it would grow to fill during measurement at `medium` too. Plain
`flexShrink: 1` leaves the column's basis as its own content, so it yields
exactly the 92pt it has to and not a point more.

Shrinking the **actions** instead is the wrong lever and was tried and rejected
in kora#263: a shrink box narrows past the word it holds, which there split
"kg" into "k" / "g". Two 40x40 icon buttons have no reflow to give — they would
simply be drawn smaller than their own glyphs. The type yields; the controls
hold.

## Verification

A green suite is not verification here — 1,729 green tests hid the original
rendering bug (kora#257). The suite is green (207 suites, 1,807 tests) and
`tsc --noEmit` is clean, and neither is the evidence.

**Visual, `accessibility-extra-large`** — `.shots/base-axl` vs `.shots/after-axl`.
Before: a sliver of one glyph at the extreme right margin. After: bell and
avatar both fully on screen, sitting right of "Today"; the greeting wraps to
three lines instead of two and the header is correspondingly taller. That is
the trade, and it is the right one.

**Tappable, not merely visible** — the failure mode being fixed is
visible-but-unhittable, so visibility was not accepted as proof. At
`accessibility-extra-large`, tapping the bell's measured centre (352, 317)
navigated to `/notifications` (confirmed by the accessibility tree: "Recent"
overline, "Notifications" title, "Nothing yet" empty state). Before the fix no
tap coordinate on a 440pt screen could have reached the avatar at all, since it
began at x=476.

**`medium` unchanged** — two independent checks, because a naive byte-compare
says "DIFFERS" and would be misread:

1. *Frames.* Post-fix `medium` a11y frames are identical to pre-fix:
   greeting x=16 w=228, "Today" x=16 w=228, bell x=332 w=40, avatar x=384 w=40.
   Nothing the fix can touch moved.

2. *Noise control.* `tab-today` does differ byte-wise between the before and
   after runs — but so does every data-backed screen, because the runs are
   separate launches and the ambient background is not launch-stable
   (NOISE-REPORT.md section 2). Capturing `medium` a second time **on the same
   post-fix code** reproduces the same magnitude:

   | pair | tab-today full frame | header band (rows 0-700) |
   |---|---|---|
   | before vs after (code changed) | maxD=107, 4.96% | 5.81% |
   | after vs after2 (code identical) | maxD=103, 3.32% | 5.77% |

   The two are indistinguishable, and untouched control screens move as much
   (`tab-progress` maxD=110, 5.44%). The `medium` diff is launch noise, not
   this change. `capture.png` across the identical-code pair is maxD=1.

## Reported, not done: should Home adopt `ScreenHeader`?

kora#276 asks this. My read: **not worth it as currently shaped**, and it should
not be bundled with a reachability fix.

`ScreenHeader` solves the same overflow by wrapping actions to their own line.
On Home that is a worse outcome than shrinking the title. Home's actions are two
40x40 icons totalling 92pt, which fit beside a 316pt title column with room to
spare; wrapping them would add a whole line of header height at
`accessibility-extra-large` to solve a problem that does not need it. The wrap
in `ScreenHeader` exists for `recipes.tsx`'s 318pt of text buttons, which
genuinely cannot share a line.

Home's header is also structurally different: a greeting line plus a large title
plus two icon actions, against `ScreenHeader`'s overline plus title plus optional
back button. Adopting it would mean either widening `ScreenHeader`'s contract or
bending Home's content to fit it, and it would change Home's visual rhythm — the
most-looked-at screen in the app — for no reachability gain. If it is done, it
should be its own change with its own before/after at both sizes.
