---
id: 260818-aus
slug: ausnut-measures
date: 2026-08-18
status: complete
---

# AUSNUT Food measures — real serving sizes for the Australian rows

## What changed

- **`api/scripts/ausnut_convert.py`** — takes the Food measures workbook as a
  second argument and joins it on `Public food key`.
- **`api/internal/nutrition/ingest/loaders.go`** — the ingest `row` schema
  gains `serving_units`, so a source file can finally reach the
  `serving_units` column that has been on `FoodItem` all along.
- **`api/internal/nutrition/repository.go`** — `BackfillServings`, wired into
  `ingest.Run` beside the existing `BackfillLocales`.
- **`api/data/food/ausnut.json`** — regenerated.

## Result, measured on a full ingest into an empty database

```
                      before        after
ausnut  with serving       0        2,261
afcd    with serving      20          347      (via BackfillServings)
index   with NO serving  6,192      3,646
```

**Rows without any serving fell from 33% of the index to 21%.** 2,604 rows now
carry named servings; 2,573 carry a default mass.

Resolution verified end-to-end against stored rows:

```
Beer, high alcohol      1 can   -> 333 g   (default 333 g)
Couscous, cooked        2 cup   -> 315 g   (default 158 g)
Pizza, ... takeaway     3 slice -> 210 g   (default  70 g)
```

## Three traps in the data, all caught by inspection rather than by a failure

**`density` is 37% of the file** (3,609 of 9,816) and is g/mL, not a portion.
Beer's density row is 1.009, so treating measures uniformly would have filed a
beer as a one-gram serving. Excluded.

**`millilitres` is a unit name, not a thing.** AUSNUT writes it with Quantity 1
and the portion mass in the gram column, so storing it as a named serving would
make the resolver read "200 millilitres" as 200 × 105 g = 21,000 g. Excluded
outright, and `TestNoSourceStoresAMeasurementUnitAsAServingName` now blocks the
whole class across every source file. It is the only such descriptor among all
390 — checked, not assumed.

**Naive "smallest measure" is wrong for 98 foods** where a tablespoon sits
beside a cup: `Couscous, cooked` would default to 13 g instead of a 158 g cup,
a 12× understatement. Spoon-scale descriptors are demoted to last resort.
`millilitres` looked like the same problem in the first pass (115 foods flagged
at ≥4×) but inspecting them showed 105 g of cordial is a glass — a real
serving. Only the spoon subset was actually wrong.

## Why BackfillServings was needed

`ingest.Run` lets the alphabetically-first file win a name+brand collision, so
`afcd_release3.json` claims every name it shares with `ausnut.json` — and AFCD
carries no servings. **315 measured servings were being silently discarded.**
This was found by end-to-end probing, not by any test: `1 can` of beer resolved
to nothing because the surviving row was AFCD's.

The backfill writes only where a row has neither a mass nor named units, so it
never overrides an owning source and a re-run is a true no-op — verified by
hashing the serving state across two consecutive ingests.

## Verification

- Nutrient payload **byte-identical** to the previous file — this adds serving
  data and perturbs no energy or macro value.
- `go test -p 1 ./internal/nutrition/... ./internal/units/... ./internal/ai/...`
  all pass.
- Ranking harness: `cases=31 rows=315 expected_known=12 hit=12 miss=0`,
  matching the recorded baseline. Ranking inputs are untouched by construction
  (name, normalized_name, entity_type and embedding are unchanged), but the
  handoff's rule is to run it rather than reason about it.
- Both new guards confirmed to actually fail before being reverted.

## Not done

- The other 3,646 serving-less rows are IFCT (522, no serving data published)
  and AFCD (1,251 remaining, likewise per-100 g reference data). Neither source
  has servings to give; they need a different source, not a join.
- 31 AUSNUT rows have measures but none inside the plausible 1–500 g band, so
  they get named units without a default mass. Correct, not a gap.
