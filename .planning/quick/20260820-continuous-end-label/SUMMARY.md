---
quick_id: 260820-cel
slug: continuous-end-label
date: 2026-08-20
refs: kora#286
status: done
---

# The continuous ruler gets kora#273's fade, because it is kora#273's clip

`apps/mobile/src/components/instrument/TickRuler.tsx` wraps the continuous
scale's graduations and labels in the same counter-translated SVG alpha mask the
detented scale got in kora#273. The lone `)` is gone. The `medium` golden for
`onboarding` changed by 8 pixels and was deliberately re-captured; the other nine
golden routes are byte-identical and were restored rather than re-baselined.

The scale cap `CONTINUOUS_LABEL_SCALE_MAX = 2.4` is **unchanged**, and the labels
are **not** shrunk. Both levers were ruled out before starting and the
measurement below confirms neither could have worked.

## Reproduced first, by sweeping — and the issue's framing was one edge out

iPhone 17 Pro Max, `medium`, ruler viewport measured from the accessibility tree
at **392pt** (x = 24..416 on a 440pt screen), so `mid` = 196.

A major's label sits at `196 + (major - value) * PX_PER_UNIT` from the
viewport's left edge. That is a function of the **value**, not of the label size,
which is the whole point below. Swept the weight ruler in single steps with
`idb ui swipe --duration 1.5`, reading `AXValue` at every step and cropping the
tick band out of the 3x capture.

**Left edge**, major 150:

| value | renders |
|---|---|
| 171.0 kg | `150` — whole, centre 7pt inside the edge |
| 171.5 kg | `50` — the leading 1 gone. Reads as a real, wrong number |
| 172.0 kg | `0` — a lone zero |
| **172.5 kg** | **`)`** — a lone paren: the right half of the 0. **kora#286** |
| 173.0 kg | nothing |

**Right edge**, major 190, mirrored:

| value | renders |
|---|---|
| 169.0 kg | `190` — whole, tick on the edge |
| 168.5 kg | `19` |
| 168.0 kg | `19` + a sliver — kora#261's `19(` |
| 167.5 kg | a lone comma-shaped sliver |
| 167.0 kg | nothing |

**The issue's "169 kg" is the right-edge ONSET, not the `)`.** At 169 the left
end label `150` is whole and 25pt clear of the edge; it is `190` at the *right*
edge that is one step from breaking. The `)` the report describes lives at
**172.5**, three and a half kilos further along. Both are the same defect and
both are fixed; the value in the issue is worth correcting because anyone
re-testing at exactly 169 sees a clean ruler and concludes there is no bug.

It is **not specific to the destination ruler.** The period is the major pitch,
10 units, on every continuous ruler:

- **height**, 172 cm -> lone `0` (major 150). Confirmed by screenshot.
- **destination weight**, 162.0 -> `0`, 162.5 -> `)` (major 140). Confirmed.
- **age** shares the geometry exactly; not separately shot.

So: three distinct on-screen rulers at `medium` (four counting imperial), a
~1.5-unit window every 10 units, at both edges.

## The code named this and drew the wrong conclusion

The note on `CONTINUOUS_LABEL_SCALE_MAX` already said a major tick can land on
the viewport edge, and already cited the exact case — `150` sitting 16.5pt from
the left edge at height 170 (measured here at 16.0pt from a column profile, so
that number was right). It then read the finding as a **limit on scaling** and
capped the label size at 2.4.

That inference does not follow. The clip position is set by the **value**; the
label size only sets how wide the window is. So the clip arrives at **scale 1.0**
and no cap can dodge it — lowering the cap would cost accessibility and buy
nothing. The comment is corrected in place rather than deleted, because the
measurement in it is sound and only the conclusion was wrong.

Shrinking the labels is out for the reason kora#263 gives (a shrink box narrows
past the word it holds, splitting `kg` into `k`/`g`), and kora#261 deliberately
scaled these labels *up*.

## Did kora#273's fade transfer?

**Structurally yes — the mechanism is identical and unmodified.** An alpha mask
inside the translated canvas, a `<Rect>` counter-translated every frame by
`useAnimatedProps` off the same `offset` shared value, per-instance gradient and
mask ids from `useId`. It runs on the UI thread and does not touch kora#176's
drag, kora#245's two-path graduations, or kora#261's label scaling.

**Three things differed and had to be adapted:**

1. **The counter-translate has a `- min` term.** The detent scale is anchored at
   stop 0 (`pad + offset * DETENT_PX - mid`); the continuous scale is anchored at
   its `min` (`pad + (offset - min) * PX_PER_UNIT - mid`). Miss this and the fade
   sits `min * 9` points away from the edge — on the weight ruler, 270pt off,
   i.e. it would mask the middle of the viewport instead.

2. **The canvas height is dynamic.** Detented mode's mask is `HEIGHT + 8`, a
   constant. Continuous mode's canvas is `svgHeight = HEIGHT + headroom`, which
   kora#261 grows with the label size. Both the `<Mask>` and the `<Rect>` take
   `svgHeight`; a constant would leave the scaled labels unmasked at the top of
   the Dynamic Type range, which is exactly where the fragments are longest.

3. **The fade ratio means something different, even though it is the same
   number.** `DETENT_FADE_RATIO` is 2.4 against labels 6-9x their own font size
   (`Sedentary`, `0.25 kg/wk`), so it covers a *fraction* of a label. A 3-digit
   continuous label measures **14.3pt at the 9pt base size** (43px in the 3x
   capture), i.e. ~1.6x its font size, so 2.4 covers **one and a half whole
   labels** — every fragment the clip can leave is inside the ramp with room
   over. Different geometry, different meaning.

   It is nonetheless deliberately the same number: `2.4 * 9 = 21.6pt` against the
   detent scale's `2.4 * 10 = 24pt`. The two controls are adjacent on the
   onboarding screen and now fade over visibly the same distance, so one clip is
   not communicated in two visual languages.

`detentFadeStop` was **not** duplicated. It becomes a thin wrapper over a shared
`edgeFadeStop(labelSize, width, ratio)`, alongside a new `continuousFadeStop`;
kora#273's four geometry tests are untouched and still pin `24/392`.

## What the clipped state looks like now

Same values, same device, after a **fresh launch** (Fast Refresh corrupts layout
measurement here):

| value | before | after |
|---|---|---|
| 171.5 kg | crisp `50` at full contrast, beside a full-strength major tick | `50` under a visible gradient, tick dimmed with it |
| 172.0 kg | crisp `0` | `0`, faint |
| 172.5 kg | **crisp `)`** | nothing — the fragment's inner tip sits at ~0.12 alpha |
| 168.0 kg (right) | crisp `19` + sliver | a faint `1` trailing off |

The fragment never gets *longer*; it gets attenuated, and the graduations fade
with it, so the scale dissolves at the container edge instead of stopping dead
with a fully-drawn tick under a severed glyph. That is kora#273's argument
applied unchanged: a picker peeking at a neighbour is fine, a lone `)` reads as
the renderer having failed.

**Verified at `accessibility-extra-large` too**, on a fresh launch, on the
destination ruler (the only continuous ruler reachable on screen at that size
without fighting the sticky header), values 70.5 -> 72.5 against major 50. The
fade is *more* effective at large text, because the runway grows with the label
(`21.6 * scale`) faster than the clipped fragment does: at 72.5 the surviving
sliver tops out around 0.18 alpha against the neighbouring `60` at full strength.
A dim ghost remains at the very edge, which is the intended reading and matches
the detent scale beside it.

## The golden comparator, explicitly

Run per `shots-golden/README.md`: Metro on 8083 restarted with
`EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00`, a throwaway account created and
onboarded by **accepting every default**, then capture and compare.

**Before re-baselining — 9 of 10 routes clean, `onboarding` FAILED:**

```
route           maxD  over48    faint%   worst block          density  verdict
about              0        0    0.000 -                           -   ok
coach              0        0    0.000 -                           -   ok
feedback           0        0    0.000 -                           -   ok
notifications      0        0    0.000 -                           -   ok
onboarding        67        8    0.104 400,680 20x20            0.8%   FAIL
recipes            0        0    0.000 -                           -   ok
settings           0        0    0.000 -                           -   ok
sign-in            0        0    0.000 -                           -   ok
tab-diary         36        0    0.611 -                           -   ok
tab-progress      21        0    0.070 -                           -   ok
```

**The failure was inspected before it was accepted.** Diffing the candidate
against the golden at 1x (box-averaged 3x3, ignoring the top 62 rows as the
comparator does), every differing pixel falls in:

- **x in [30, 43] and [397, 409]** — the outer ~14pt inside the 24..416
  container, i.e. the fade runway, and nothing else across the full 440pt width;
- **y in 586-614, 683-711, 780-808** — exactly the three visible continuous
  rulers (age, height, weight).

The detented goal ruler above them (y ~ 350-400) is untouched, which is the
direct evidence that kora#273 was not disturbed. Only the outermost minor
graduations differ at the default values, because at 30 / 170 / 70 no end label
is near an edge — the 8 pixels are the fade doing its job on ticks.

**The change is intended, so the golden was re-captured via the golden path**
(`node scripts/shots-golden.mjs --port 8083`, no `--force`, no threshold
touched). `shots:golden` rewrites all ten files, so the nine that were
**pixel-identical** (verified per-file, `getbbox()` empty) were restored from
`HEAD` rather than committed as re-encodes; `tab-diary` and `tab-progress` drift
sub-threshold from run to run and were restored for the same reason — they passed
against the old goldens both before and after this change, and baking a
throwaway account's noise into them would be dishonest. `manifest.json` carries
the new `capturedAt`, `gitCommit` and the one changed byte count.

**After — a fresh capture against the committed set:**

```
onboarding         0        0    0.000 -                           -   ok
All 10 compared route(s) within tolerance.
```

So: exactly one golden file changed, `shots-golden/medium/onboarding.png`, and
the reason it changed is visible in the diff geometry above.

## Tests

`TickRuler.test.tsx` gains nine cases under `TickRuler continuous edge fade
(kora#286)`, carrying the measured decay table in the describe comment: that the
continuous scale group renders a mask; that the **graduations and the labels are
both inside it** (fading the numbers while leaving a full-strength tick at the
edge is the exact misreading this fixes); that ids are per-instance across two
continuous rulers *and* across a continuous and a detented one; and five on
`continuousFadeStop` — that the runway exceeds a whole 14.3pt label, that it
lands within 3pt of the detent scale's on the same viewport, that it grows with
Dynamic Type, the 0.45 clamp, and inertness before the first layout.

Suite: **207 suites / 1826 tests pass.** `tsc --noEmit` clean. `npx eslint` on
`TickRuler.tsx` reports the **same 9 pre-existing errors before and after** the
change (all `react-hooks/immutability` on `useDragReport`'s worklet assignments,
untouched here) — this change adds none. Prettier was not run; it is not this
repo's formatter.

## Not done, deliberately

- **Raising `CONTINUOUS_LABEL_SCALE_MAX`.** The fade now protects the container
  edge at every scale, so the edge argument for 2.4 is gone — but 2.4 also
  doubles as the vertical-headroom and legibility ceiling, and re-deriving that
  is a separate measurement. The comment records that raising it no longer costs
  edge safety, so the next person is not blocked by a stale reason.
- **Lowering the cap.** Cannot help; the defect is at scale 1.0.
- **Any attempt to reveal more text.** The clip is inherent to a wide canvas
  translated under a fixed centre index. kora#273 settled this.

## Simulator state

Content size restored to `medium`. Throwaway account `s286@kora.test`
**deleted through the app's own delete-account flow and confirmed deleted** —
signing in with the same credentials that worked minutes earlier now returns
"Email or password is incorrect." Metro on 8083 stopped; **8081 and 8082 left
running and untouched.**
