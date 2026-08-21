---
quick_id: 260819-rll
slug: ruler-labels-and-low-items
date: 2026-08-19
refs: kora#261, kora#173
branch: fix/261-ruler-labels-dynamic-type
commits:
  - c993bea8 fix(a11y) scale the ruler's SVG scale labels with Dynamic Type (#261)
  - f43f903a fix(a11y) keep the gauge caption off the needle hub at large text sizes (#173)
  - dd6f4acd fix(a11y) keep all three sign-in controls above the fold at large text sizes (#173)
---

# Summary — ruler labels into Dynamic Type, plus the two LOW items on #173

All three tasks landed. Everything below was measured on device (iPhone 17 Pro
Max, prod API) at `medium` and `accessibility-extra-large`, with an extra probe
at `accessibility-extra-extra-extra-large` for Task A.

Two measurement facts that shaped the work, both consistent with
`.planning/debug/resolved/lineheight-double-scaled.md`:

- `PixelRatio.getFontScale()` reports **0.941 at `medium`** and **2.643 at
  `accessibility-extra-large`** on this device. `medium` is one step BELOW iOS's
  default `large`, which is why every cap below is written as
  `min(max(fontScale, 1), cap)` — the floor at 1 is what makes `medium`
  byte-identical.
- **Fast Refresh corrupts font-metric measurements.** Three of my Task B probes
  disagreed with each other until I re-ran every one on a fresh app launch.
  Anything here about type size or line boxes came from a fresh launch.

---

## Task A — the ruler's SVG labels now scale (#261)

`src/components/instrument/TickRuler.tsx`. `<SvgText>` takes a raw numeric
`fontSize` and never consults Dynamic Type, so both label sets rendered
identically at every text size. Fixed by scaling the font sizes from
`useWindowDimensions().fontScale`, per the plan's chosen approach. kora#245's
two-path graduation drawing and kora#176's drag machinery are untouched.

### Multipliers achieved, and what limited each

| | design size | achieved | limited by |
|---|---|---|---|
| continuous graduations (age/height/weight/destination) | 9pt | **2.4x** | the container's clip edge, measured |
| detent stop labels (goal/activity/pace) | 10pt | **1.6x** | neighbour collision, measured |

**Continuous — 2.4x, limited by the viewport edge, not by neighbours.**
Adjacent labels have enormous slack (a 3-digit label is ~16pt wide on a 90pt
pitch), so collision is not the constraint. The constraint is that a major tick
can land right on the viewport edge — it does at height 170, where the "150"
tick sits 16.5pt from the left edge — and the label is centred on it, so half of
it hangs over `overflow: "hidden"`.

Measured by lifting the cap and re-running at AX5 (fontScale ~3.3): the end
labels render as `50` and `19(`. Label runs across the height ruler, device px:

```
capped 2.4x    (72,169,98) (340,440,101) (612,708,97) (880,980,101) (1150,1247,98)
uncapped 3.3x  first label's leading "1" gone entirely; last label 81px wide vs ~109
```

At 2.4x the end labels measure the same width as the middle ones (98 vs 97–101),
i.e. not clipped, with the leftmost starting at x=71.5 against a container edge
at 72. **The cap is within about one point of the real limit** — 2.4 is what the
geometry holds, not a taste call. The system already reaches it at
`accessibility-extra-large`, so AXL and AX5 render identically.

Measured growth of the "80" label's cap height: **21px -> 48px** (medium -> AXL).

**Detent — 1.6x, limited by neighbour collision.**
"Maintain" <-> "Build muscle" is the widest adjacent pair. Label clusters on the
goal ruler, device px:

```
before (AXL)  Lose weight 571-749 | Maintain 887-1008 | Build m 1144-1247   gaps 138, 136
after  (AXL)  Lose weight 526-795 | Maintain 857-1040 | Build m 1098-1247   gaps  62,  58
```

62px and 58px is ~20pt and ~19pt of clear space. Extrapolating the measured
half-widths they touch at ~2.0x; the tightest pace pair (two 10-character
"0.25 kg/wk" strings) keeps ~16pt at 1.6. Going to 1.8 would leave the pace
ruler ~6pt, which is a smear rather than two stops. **1.6 is the honest number.**

Proves the bug directly: "Maintain" measured **h=23 w=122 at `medium` and h=23
w=122 at AXL before the change** — pixel-identical, as the plan said. After:
h=37 w=184 (1.61x by height).

### Did I have to thin the continuous label set?

**No.** Thinning was on the table in the plan and turned out to be unnecessary —
the continuous labels never collide with each other in the range this control
can reach. The full label set renders at every size.

### Did the detent end-label clipping ("Sedentary" -> "entary") change?

**Essentially not — a hair worse in proportion, meaningfully better in
legibility.** Measured on the activity ruler with "Moderate" selected:

| | visible fragment | full label | fraction visible |
|---|---|---|---|
| `medium` | 72-157 px (86) | ~155 px | 57.7% |
| AXL, after | 72-197 px (126) | ~235 px | 54.9% |

Same characters (`entary` / `Very a`) at both sizes; the visible piece is 46%
larger in absolute terms and therefore easier to read, but it cuts at nearly the
same point in the word.

**This is not a scaling artefact and the fix neither caused nor cures it.** With
5 stops on a 96pt pitch, the outermost stop's centre sits only ~4pt inside the
container (container 72-1247 px, mid 660, stop 0 at 660 - 2x96x3 = 84), so more
than half of the first and last labels is outside the viewport at ANY text size.
Fixing it needs a different layout for the stop labels — a viewport-relative
label set, an edge fade, or a pitch that shrinks with the available width —
which is the case the plan told me to report rather than force. **Not attempted.**

### Vertical room

The continuous ruler grows its canvas by `ceil(9 * 0.75 * (scale - 1))` and
pushes the tick geometry down by the same amount, so taller labels get room
above the ticks without changing their relationship to the baseline. Zero at
scale 1. The container's `minHeight` (kora#260) does absorb it — verified: at AXL
the ruler rows are taller and nothing is clipped. The detent ruler needed no
headroom at its 1.6 cap (its glyphs still start ~10pt below the canvas top).

### `medium` unchanged

Two screenshots at the onboarding position showing FOUR rulers (weight
continuous, activity detent, destination continuous, pace detent), one with the
change and one with `git checkout --` applied, differ **only** in the
`expo-dev-menu` FAB: diff bbox `(1098, 255, 1296, 438)`. Everything else is
byte-identical.

### Tests

Nine new tests in `TickRuler.test.tsx` pinning the rendered `fontSize` (not just
the helpers — a green suite is what let this ship the first time), including one
that both modes stay at 9/10pt when text is not enlarged. Continuous graduations
gained a `testID` so they can be addressed individually.

---

## Task B — GaugeDial caption vs the needle hub (#173, LOW)

**The existing 1.6 cap on the hero numeral was itself the bug, and capping the
caption cannot fix it.** The caption is laid out against the numeral's line box,
so the numeral is what has to give. Lowering only the caption's cap (1.4 -> 1.2)
moved its top not at all — measured.

The budget is fixed and tiny: the overlay starts at 38% of the 178pt face
(67.6pt) and the hub dot's top edge is at 141.5pt, so numeral + 6pt gap +
caption have **73.9pt**. At the design size that stack is 50 + 6 + ~17 ~= 73pt.
About one point of slack, and every tenth of numeral growth spends roughly five.

Swept on device, each on a **fresh launch**:

| numeral cap | result |
|---|---|
| 1.6 (before) | dot renders inside the word "RESERVE" |
| 1.2 | dot back inside "RESERVE" |
| 1.1 | dot level with the caption's baseline — grazing |
| **1.0 (shipped)** | ~4pt of clear space below the caption |

So `CENTER_NUMERAL_MAX_SCALE = 1.0`. Less of an accessibility loss than it looks:
the numeral is authored at 44pt, ~2.6x the 17pt body size — already drawn at
accessibility scale by design — and the reserve is announced in full by the
dial's `accessibilityLabel`, which is the surface that has to scale. The caption
keeps its own 1.4.

Growing this properly means a bigger face (`GAUGE_VIEW_H` and the tick geometry
derived from it), i.e. redrawing the instrument. Not done, noted in the code.

`medium` verified unchanged: numeral, caption and hub sit at identical y in
before/after fresh launches. (Two Home screenshots from different launches carry
~1px antialias ghosting across the whole card even with identical code — 3,933
pixels above threshold with NO change applied — so the compare was done on the
gauge crop, which is exact.)

The existing GaugeDial test asserting `1.6` was updated with why.

---

## Task C — sign-in's email button below the fold (#173, LOW)

**Fixed.** At AXL all three controls are on screen at first paint with ~40pt to
spare.

Measured deficit: the email button needed ~126pt more than the viewport had.
What gives way at `fontScale > 1.5`:

- the subtitle ("Sign in to pick up where you left off.") — two lines, ~96pt
  plus the scaffold's 16pt gap
- the collapsible top spacer's 32pt floor

~144pt, which is enough. **The brand lockup deliberately stays** — it was the
obvious next thing to drop, I tried it, and it turned out not to be needed; it
is also the only thing on the screen that says which app is asking for
credentials. **The title's type is not capped**, per the plan.

The 1.5 threshold sits between iOS's largest non-accessibility size (xxxL, ~1.35)
and its smallest accessibility one (AX1, ~1.64), so no non-accessibility user
sees any change.

`medium` verified: the after screenshot is **byte-identical** to the pre-change
baseline (diff bbox `None`, max difference 0).

Two new tests pin what gives way and what does not.

---

## Verification summary

- Full suite: **1,799 tests / 205 suites green**.
- `tsc --noEmit` clean.
- `eslint` on TickRuler reports the same 9 pre-existing errors as `HEAD` did
  (ref-during-render and shared-value mutation in the kora#176 drag machinery,
  lines unchanged by this work) — **no new lint errors**. Not fixed: out of scope.
- Test account `rl261@kora.test` created for the run and deleted through the
  app's own delete-account flow.
- Simulator `content_size` restored to `medium`.
- My Metro on 8083 stopped; the pre-existing one on 8082 untouched.

## Known non-fixes, stated plainly

1. **Detent end labels are still cut at the viewport edges** at every text size.
   Fixed geometry (5 stops x 96pt against a 392pt container), not a scaling bug.
   Needs a different stop-label layout.
2. **The gauge's hero numeral no longer grows at all** with Dynamic Type. That is
   the price of keeping the caption off the hub inside a 178pt face.
3. **Sign-in's signup mode** still pushes the email form's submit below the fold
   at AXL once the form is revealed. Out of scope — Task C was about the three
   provider controls on first paint.

---

## CORRECTION — Task B was measured, then rejected and NOT shipped

Everything recorded above about Task B's measurements stands. The **decision**
does not: the fix was reverted before this branch was pushed, and
`GaugeDial.tsx` is byte-identical to `main` on this branch.

**Why.** Capping the centre numeral at `1.0` fixes the caption overlap by
removing Dynamic Type from the Home screen's primary readout. That is the wrong
trade for a LOW cosmetic finding — this whole line of work (#260, #263, #266)
has been about restoring Dynamic Type, and paying for a caption position with
the number a user most wants to read reverses it. A user at 300% text would get
no growth at all on the dial's value.

The counter-argument in the reverted code was not unreasonable — 44pt is
already ~2.6x body, and the value is announced in full by the dial's
`accessibilityLabel`. It was weighed and rejected on the balance above, not
overlooked.

**What the measurements are still good for.** They establish that the caption
cannot be rescued by capping the caption, and that the real fix is a taller
face:

- overlay top at 67.6pt, hub-dot top at `GAUGE_CENTER_Y - 4.5` = 141.5pt
- so numeral + 6pt gap + caption have **73.9pt**, against a stack already ~73pt
  at design size — roughly one point of slack
- swept on fresh launches: 1.2 puts the hub dot back inside "RESERVE", 1.1 is
  level with the caption baseline, 1.0 leaves ~4pt clear

A fuller fix means growing `GAUGE_VIEW_H` and the tick geometry derived from it
— a redraw of the instrument, not a cap change. These numbers are carried into
the issue filed for that work so nobody has to re-measure them.

**Still true and unchanged:** the caption/hub overlap at accessibility sizes
remains a live LOW finding on kora#173.

## Note on Task B's verification artefact

The after-screenshot taken at the 1.0 cap (`r2/45-home-axl-AFTER.png`) shows the
numeral's glyph tops apparently sliced. This was NOT confirmed to be clipping —
the 1.3 probe (`r2/42-home-axl-probe13-crop.png`) renders the same numeral
cleanly with room above, and 1.0 is smaller still, so it is most likely the
`AnimatedNumber` odometer caught mid-roll. Moot now that the change is reverted,
but recorded so it is not mistaken for evidence of a clipping bug later.
