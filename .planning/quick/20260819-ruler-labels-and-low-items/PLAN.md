---
quick_id: 260819-rll
slug: ruler-labels-and-low-items
date: 2026-08-19
refs: kora#261, kora#173
---

# Ruler labels into Dynamic Type, plus the two LOW items on #173

Three tasks, three atomic commits. Task A is the hard one and the reason this
branch exists; B and C are small and are being folded in because they live on
screens Task A already requires visiting.

---

## Task A — the ruler's SVG labels never scale (#261)

`src/components/instrument/TickRuler.tsx` renders its labels through
`<SvgText>` from `react-native-svg`, which is outside Dynamic Type entirely.
Two sites:

- **`:524-533`** — continuous ruler graduation numbers, `fontSize={9}`,
  `y={BASELINE - 22}`. The age / height / weight scales.
- **`:648-659`** — detent stop labels, `fontSize={10}`, `y={BASELINE - 14}`.
  "Lose weight" / "Maintain" / "Build muscle", the pace labels, and the
  activity scale.

Measured: screenshots of these at `medium` and `accessibility-extra-large` are
**pixel-identical**. Everything around them roughly triples.

**Chosen approach (decided by the repo owner): scale the SVG font sizes from
`useWindowDimensions().fontScale`, capped.** Do NOT move the labels out of SVG
into RN `<Text>` — kora#245 deliberately moved this component's graduations
into two SVG paths for performance, and that is not being reopened here.

Use `useWindowDimensions()`, not `PixelRatio.getFontScale()` — the former is
reactive, so the control responds when the user changes text size and returns
to a still-mounted app. That is the pattern `AppleSignInButton` and
`DayTotalCluster` already use (#260).

### The part that needs measuring, not reasoning

Larger labels will collide, and the geometry around them is fixed points:

1. **Continuous ruler:** labels sit at computed `x` intervals. At a large scale
   adjacent numbers will overlap. If they do, the honest answer is probably to
   **thin the label set** — render every other label — rather than to cap so low
   the change is pointless. Measure before deciding.
2. **Detent ruler:** the end labels ALREADY clip horizontally at `medium`
   ("Sedentary" renders as "entary", "Very active" as "Very a"). Scaling makes
   that worse. Fixing the clip is in scope if it is small; if it turns out to
   need a different layout for the stop labels, report that and cap
   conservatively instead.
3. **Vertical room:** `y` is derived from `BASELINE`. Taller labels may need the
   baseline offsets to track the scale too. The container is already `minHeight`
   (#260) so it can grow — check that it actually does.

### The floor this control has, which lets you cap sensibly

The ruler's **readout** ("30 years", "170 cm") is a real RN `Text` and already
scales correctly (#165, #260). So there IS an accessible surface for the value
regardless of what the scale labels do. That makes a moderate cap defensible —
the labels are supplementary orientation, not the only way to read the control.

**A partial win is acceptable here and is much better than a collision.** If the
measurement says the labels can only reach ~1.3x before colliding, ship 1.3x,
say so plainly in the commit and in a comment on #261, and note what a fuller
fix would need. Do not force a number the geometry cannot hold.

---

## Task B — GaugeDial caption collides with the needle hub (#173, LOW)

`src/components/instrument/GaugeDial.tsx:431-456` — the engraved caption
("kcal in reserve" / "kcal over budget"). At accessibility sizes it sits on top
of the needle hub, and the hero numeral crowds the tick arc.

The overlay has fixed insets (`OVERLAY_BOTTOM`, derived at `:101`) and the
numeral is already capped at 1.6 with a comment explaining the cap IS the
overflow protection. The caption appears not to have the same protection.

Cosmetic, so a cap is a legitimate answer. Keep it consistent with the numeral's
existing 1.6 unless measurement says otherwise.

---

## Task C — sign-in's email button below the fold (#173, LOW)

At `accessibility-extra-large` only Apple and Google are visible on first paint;
"Continue with email" needs a scroll. Reachable, so this is discoverability, not
a blocker — and it is already far better than the ~7 swipes it took before #260.

Cheapest honest fix is probably to let the hero (brand lockup + title +
subtitle) give up room at large text scales so all three controls stay above the
fold. Do NOT cap the hero's type — shrinking the headline to fit is the wrong
trade on the screen a user lands on when they cannot sign in.

If nothing small and non-hacky achieves it, **say so and leave it**. This is a
LOW item and not worth a contorted layout.

---

## Constraints

- **A green suite is NOT verification.** Screenshots at BOTH `medium` and
  `accessibility-extra-large` for every claim. 1,729 green tests hid the
  original bug in this family (#257).
- `medium` must be visually unchanged by all three tasks. Byte-compare where you
  can — that is what caught a regression in #266.
- Do not reopen kora#245's two-path graduation drawing, and do not touch the
  drag/UI-thread work from kora#176.
- Task A's readout was fixed in #165 and #260 — leave it alone.

## Acceptance

- Ruler labels visibly scale at accessibility sizes, without collisions, with the
  achieved multiplier stated honestly.
- GaugeDial caption clear of the hub at both sizes.
- Sign-in: all three buttons above the fold at AXL, or a written explanation of
  why not.
- `medium` unchanged throughout.
- Three atomic commits, single-line conventional messages, NO signature, NO
  Co-Authored-By trailer.
