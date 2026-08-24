---
status: complete
issue: 419
---

# 419 — the weight chart broke on instrument change while its delta measured across it

## What changed

1. `metricSeries` computes `breaksAfter` only when `!fitsAcrossInstruments(compositionMetric(key))`.
   Weight and every `length` (tape) metric now draw one continuous line; composition
   percentages still break. This is #397's rule, which had reached `comparableRunFor`
   and never reached the chart.
2. `instrumentChangeNote(sources)` replaces an inline template that hardcoded
   "the two" regardless of how many instruments the series spanned.
3. `provenanceLabel` renames `manual` to "typed in" **for prose only**.
   `sourceLabel` is untouched, because the form's "Measured with" picker means
   the instrument — there `manual` really is a scale and "Scale" is right.

## Tests

Watched fail first, all six:
- weight series across three sources → `breaksAfter` was `[0,1]`, wanted `[]`
- tape series across two sources → was `[0]`, wanted `[]`
- `hasInstrumentChange` on a weight series → was `true`, wanted `false`
- three note tests → `instrumentChangeNote` did not exist

One **pre-existing test was wrong and was changed**: it asserted
"an instrument switch breaks a tape line just like a scale one", which contradicts
#397's own stated reasoning that `source` records the weigh-in's instrument, not
the tape's. Behaviour kept, assertion corrected.

37 suites / 405 tests green. `tsc --noEmit` clean. Lint clean (one pre-existing
unused-import warning in progress.tsx, untouched).

## Not verified

Device rendering. The change removes a break and a sentence; that it *looks*
right on the Trends card is unconfirmed until the next build.
