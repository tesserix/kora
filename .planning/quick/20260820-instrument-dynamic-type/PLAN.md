---
quick_id: 260820-idt
slug: instrument-dynamic-type
date: 2026-08-20
refs: kora#268, kora#284, kora#261, kora#270, kora#257
---

# One Dynamic Type rule for instrument SVGs

Fixes #268 and #284.

They ship together because they are the same fix on two components that
deliberately share geometry. `PlanDial`'s own comment — *"Same geometry, so the
two read as one panel"* — is the constraint: picking a scaling rule for one
constrains the other, so doing them separately means doing the second one twice
(#284's argument, adopted).

## The rule

**SVG content sits outside Dynamic Type entirely.** A `<Svg>` with a fixed
`viewBox` draws at the same physical size at `xSmall` and at `AX5`, which is why
`TickRuler`'s labels never scaled (#261) and why the onboarding hierarchy
inverts (#284): the numeral roughly doubles while the dial — the thing that
makes the screen read as an instrument — does not move.

#261 established the house pattern for this: drive the SVG from
`useWindowDimensions().fontScale`, floored at 1 and capped by what the geometry
can hold (`labelFontScale`). This applies the same pattern one level up — to the
**instrument**, not its labels:

> Scale the **rendered** `width`/`height` of the `<Svg>` by
> `clamp(fontScale, 1, cap)` and leave the `viewBox` at `0 0 264 178`.

Consequences that make this the cheap option:

- Every tick, both needle worklets, `scaleAnchor` and `buildGaugeTicks` are
  **untouched**. It is a pure vector scale-up, not a geometry rework. None of
  the worklet-directive minefield in `gauge.ts` / `GaugeDial.tsx` /
  `PlanDial.tsx` is opened.
- Floored at 1, so **`medium` is byte-identical** and the existing goldens at
  the default content size do not move. Same property #261's fix was built to
  have.

### This is also #268's "grow the face"

#268 asks for a bigger `GAUGE_VIEW_H` because the centre overlay's budget is
73.9pt against a stack that is already ~73pt at design size — about one point of
slack, and every tenth of numeral growth spends roughly five of it.

Scaling the face by `s` scales that budget to `73.9·s`, which is exactly the
"grow the face" #268 asks for, except it grows **when the text inside it
grows** rather than unconditionally. Against `stack(f) = 50·min(f,1.6) + 6 +
17·min(f,1.4)`:

| fontScale | budget `73.9·s` | in-face stack | slack |
|-----------|-----------------|---------------|-------|
| 1.0       | 73.9            | 73.0          | 0.9pt (today) |
| 1.4       | 103.4           | 99.8          | 3.6pt |
| 1.6       | 118.2           | 109.8         | 8.4pt |
| 3.0 (capped) | 118.2        | 109.8         | 8.4pt |

The 73.9 is #268's own measurement, re-derived here from the constants rather
than copied: `GAUGE_CENTER_Y - HUB_DOT_R - 0.38·GAUGE_VIEW_H` = `146 - 4.5 - 67.64` =
**73.86**. It must be asserted in a test, not trusted. (The table above is
computed from 73.86; an earlier draft rounded to 73.9 first, which is where its
103.5 row came from.)

### The cap is set by WIDTH, not by the font caps

`GAUGE_VIEW_W * 1.6 = 422.4pt`, so on any screen narrower than that the width
clamp binds first and `s` never reaches 1.6.

**CORRECTED during task 1.** This section originally said the clamp "claws `s`
back to roughly 1.34 on a 393pt device". That is wrong as stated: `393 / 264 =
1.4886`, and at that scale the budget is `109.95` against a stack of `109.8` —
the caption **fits, by 0.15pt**. The 1.34 figure is what you get from ~354pt,
i.e. a *padded content* width reported as if it were the screen width.

The conclusion survives, but the reason is different and the margin is the
point:

- Break-even is **392.46pt of available width**. A raw 393pt screen sits 0.54pt
  above it.
- 0.15pt of clearance is **thinner than the error bar on `CAPTION_LINE_RATIO`**,
  which is an estimate of RN's default leading. At 1.72 rather than 1.70 it is
  already negative.
- Any horizontal padding at all tips it. `GaugeDial` on Home sits inside a
  `padding: 16` container, so its real available width is at most 361pt on a
  393pt device — `s = 1.337`, budget `98.8`, and the caption **does not fit**.

So the ejection path is necessary, and the predicate must be fed the
component's **available layout width, not `useWindowDimensions().width`**. On a
393pt device those two differ by exactly enough to flip the result — window
width would report a fit and the device would clip.

No `maxFontSizeMultiplier` anywhere is lowered. That trade was explicitly
weighed and rejected in #268 and #267, and this plan does not re-open it.

## Tasks

### 1. `gauge.ts` — the shared scale, as pure exported functions

`instrumentScale(fontScale, maxWidth)` and the overlay-fit arithmetic
(`overlayBudget(s)`, `overlayStack(fontScale)`) are **exported pure functions**,
following `TickRuler`'s `labelFontScale` / `labelHeadroom` / `edgeFadeStop`
precedent: the geometry tests pin the numbers instead of re-deriving them from a
screenshot.

- Floor at 1 in both directions — a user who SHRANK their text never gets a dial
  smaller than the design, matching `labelFontScale`'s reasoning.
- `maxWidth <= 0` (first paint, before layout) returns the unclamped want rather
  than collapsing to zero. **This is the #270 failure mode** — a dimension that
  resolves to 0 and reads as deliberate whitespace for the component's whole
  life. Guard it explicitly and test it.

### 2. `GaugeDial` — scale the face, eject the caption when it will not fit

- `<Svg>` gets `width={GAUGE_VIEW_W * s}` / `height={GAUGE_VIEW_H * s}`,
  `viewBox` unchanged.
- The overlay's `top: "38%"` is a percentage and already scales. **`bottom:
  OVERLAY_BOTTOM` is in points and does not** — it must become
  `OVERLAY_BOTTOM * s`. Missing this is the whole bug in miniature.
- When `overlayBudget(s) < overlayStack(fontScale)`, render the caption as a
  sibling **below** the `<Svg>` instead of inside the overlay. Same text, same
  style, same colors, same lume rule (`over` still gets no glow).
- The `accessibilityLabel` on the root already announces the full reading and
  must not change — ejecting the caption is a visual move only.

### 3. `PlanDial` — the same scale, plus a viewport budget

Same `<Svg>` treatment. It has no centre overlay, so no fit test.

It additionally takes a `maxHeight` so the onboarding header can bound it — see
task 4. Same #270 guard: an unresolved/absent budget must not collapse the dial.

### 4. `AuthScaffold` + `onboarding` — the header stops being sticky at AX sizes

#284's second half. At `accessibility-extra-large` the scroll region reaches
only "Age": both rulers and the goal selector are below the fold on first paint.
Capping the dial does not fix this — **the numeral and the captions are what
double**, and shrinking those is the `flexShrink` failure class #263 ruled out.

Decision: `fontScale > 1.3` moves the header to be the first child of the
`ScrollView` instead of a sibling above it. At or below the threshold nothing
changes at all.

- The rulers become reachable on first paint at every text size.
- The dial scrolls away at AX sizes. That is the right trade: the rulers are the
  controls, the dial is the readout.
- `medium` is untouched, so the `onboarding` golden at the default size does not
  move.

`AuthScaffold` is shared with sign-in, which passes no `header` — that path must
be provably unaffected.

### 5. `PlanDelta` — reserve its line

#284's incidental, folded in because the area is open. `PlanDelta` returns
`null` until the first ruler change, then appears and pushes the rulers down
~34pt **under the sticky header, moving the drag target mid-interaction**. It
cost a silently-missed swipe during #270's verification.

Reserve the space instead of collapsing it, so nothing moves when the message
arrives.

### 6. Tests — and a warning about what tests are worth here

Unit-test the exported arithmetic (`instrumentScale`, `overlayBudget`,
`overlayStack`, the fit predicate, the zero-width guard) and the rendered
`width`/`height`/`viewBox` props at several `fontScale` values via a mocked
`useWindowDimensions`.

**Do not conclude anything from a green suite.** #257: animated transforms are
invisible to Jest, and a clipped-ruler regression shipped past 1,729 green
tests. #284 says it outright — *"Do not rely on the test suite."*

## Verification

Both screens are reachable and both are already in the golden set.

- Home (`GaugeDial`): signed-in simulator.
- `onboarding` (`PlanDial`) is **pre-auth reachable** — sign-in > "Create an
  account" lands directly in it.

```
node apps/mobile/scripts/shots.mjs --content-size accessibility-extra-large
node apps/mobile/scripts/shots-compare.mjs
```

`medium` must come back byte-identical (that is the floor-at-1 property, and is
the single strongest signal this plan is implemented correctly). The AX captures
are a deliberate golden update.

### Traps recorded by the issues — do not rediscover these

- **Fast Refresh corrupts font-metric measurements** on `GaugeDial`. Three
  probes contradicted each other until every one was re-run on a fresh launch
  (`.planning/debug/resolved/lineheight-double-scaled.md`). Budget for
  relaunches; never trust a measurement taken after a hot reload.
- A screenshot of the centre numeral **can look vertically sliced** when the
  `AnimatedNumber` odometer is caught mid-roll. That is an artefact, not
  clipping — confirm against a settled frame before chasing it.
- **The ejection path does not reproduce on the iPhone 17 Pro Max simulator.**
  At 440pt wide, even after Home's `padding: 16`, the available width is ~408pt,
  `s = 1.545`, budget `114.1` >= stack `109.8` — the caption stays in the face.
  Ejection needs available width **below 392.46pt**, i.e. a 393pt-class device
  (iPhone 17 Pro / 16 Pro). Verifying only on the usual Pro Max simulator will
  show you the non-ejecting branch and tell you nothing about the one this issue
  is about.
- Do not run prettier in this repo.
