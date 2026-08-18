---
id: 260818-aus
slug: ausnut-measures
date: 2026-08-18
status: in-progress
---

# Wire up AUSNUT Food measures — real serving sizes for 3,238 Australian rows

## Why

Measured in prod, not assumed: **6,192 of 18,878 rows (33%) have no serving
size at all** — `serving_grams` is NULL or 0.

```
ausnut  3,238 rows — 3,238 unset      afcd  1,611 — 1,553 unset
off     5,670 rows —   878 unset      ifct    523 —   523 unset
```

AUSNUT publishes 9,816 measures in a separate "Food measures" workbook that
`ausnut_convert.py` has never read. Joining it fixes the largest single block.

## What the data actually looks like

- 9,816 measure rows over 3,713 foods, joined on **`Public food key`** (column
  index 1 in *both* sheets).
- **3,609 of them are `density`** (g/mL, e.g. beer at 1.009) — not servings.
  Excluding them leaves 6,207 real measures over **2,618 foods**.
- 1,203 foods have exactly one measure; 1,415 have several, median spread
  between largest and smallest **5×**. So the choice of primary matters.

## Mapping

`units.ServingUnit{Name, Amount, BaseAmount}` already matches AUSNUT's
`(Descriptor 1, Quantity, Gram amount)` 1:1. The model has carried a
`serving_units` jsonb column all along — the ingest `row` struct simply has no
field for it, so no file has ever been able to populate it.

Both tiers of `portionGramsFor` are worth filling, and they are different
things:

- **`serving_units`** → tier 2, the food's own named servings. Makes "1 can",
  "2 slices", "1 cup" resolve against *this row's* mass. No judgement needed:
  emit every non-density measure.
- **`serving_grams`/`serving_desc`** → tier 4, the default when the phrase
  names nothing. Needs a policy, below.

## The one judgement call: which measure is the primary

Chosen on evidence, not intuition.

**Smallest plausible measure (1–500 g, matching `plausibleServingGrams`), but
never a spoon-scale descriptor when a larger real unit exists.**

- Smallest is right for the common case: AUSNUT lists the same food in several
  container sizes (beer: can 333/378/504/656 g). 333 g is the standard
  stubby; the larger ones are multi-serve packaging. The median (~440 g)
  matches no real container.
- The naive "just take the smallest" rule fails on **98 foods** where a
  tablespoon coexists with a cup — `Couscous, cooked` would default to 13 g
  instead of a 158 g cup, understating by 12×. So `teaspoon`, `tablespoon`,
  `pinch` and `handful` are demoted: used as the primary only when a food has
  nothing else.
- Checked and deliberately NOT demoted: `millilitres` (105 g of cordial is a
  glass, a sane serving) — the earlier ≥4× flag caught 115 foods, and
  inspecting them showed only the spoon subset was actually wrong.

Duplicate descriptor names within one food (beer has four `can` rows) collapse
to the smallest, consistent with the above. `servingGramsFromPhrase` takes the
first match, so leaving duplicates in would make the resolved mass depend on
row order.

## Tasks

1. `api/internal/nutrition/ingest/loaders.go` — add `serving_units` to the
   `row` struct and carry it onto the FoodItem. Reject implausible/malformed
   entries rather than storing them.
2. `api/scripts/ausnut_convert.py` — take the measures workbook as a second
   argument, join on `Public food key`, emit `serving_units`, `serving_grams`
   and `serving_desc`. Header check extended to the key column and the
   measures sheet.
3. Regenerate `api/data/food/ausnut.json`.

## Verification

- Nutrient values must be **byte-identical** to the committed file — this
  change adds serving data and must not perturb energy or macros.
- Ingest into an isolated empty DB; confirm ausnut serving coverage and that
  `Couscous, cooked` lands at the cup, not the tablespoon.
- `go test -p 1 ./internal/nutrition/... ./internal/ai/...`
- Spot-check that a "1 can" phrase resolves against a beer row.
