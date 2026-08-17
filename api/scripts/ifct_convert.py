#!/usr/bin/env python3
"""Convert the Indian Food Composition Tables (IFCT 2017) to the ingest schema.

    git clone --depth 1 --branch 2.0.5 https://github.com/ifct2017/compositions
    python3 scripts/ifct_convert.py compositions/index.csv > data/food/ifct.json

Source: github.com/ifct2017/compositions, a machine-readable transcription of
IFCT 2017 (National Institute of Nutrition, Hyderabad).

LICENCE — PIN THE TAG. Tag 2.0.5 is MIT. HEAD is AGPL-3.0, which Kora cannot
take. The clone above pins 2.0.5 deliberately; do not "update" it to HEAD
without redoing that assessment. The generated JSON is committed, exactly as
data/food/afcd_release3.json and usda_sr_legacy.json are, so neither the build
nor the deploy needs this script or the upstream repo.

WHY THIS EXISTS: the index was 51% USDA (7,764 rows) serving a user base that
is primarily India and Australia. AFCD Release 3 covered the Australian half
(see afcd_convert.py); this covers the Indian half with 528 foods measured in
India. Indian staples previously resolved to US reference rows or to nothing.

ENERGY IS KILOJOULES. IFCT's `enerc` column is kJ, not kcal — importing it
as-is overstates every row by 4.184x. That single mistake would put a 356 kcal
food in the log at 1,490. Converted here, once, at the boundary.

CARBOHYDRATE: `choavldf` — available carbohydrate by difference, which excludes
dietary fibre. This matches the AFCD rows' convention rather than USDA's
"carbohydrate by difference", which includes fibre. Per afcd_convert.py, the
conventions are chosen per-source rather than harmonised, so each row matches
the convention its own food would be labelled under.

NO SERVING SIZES: IFCT is per-100 g reference data and states no serving, so
serving_grams is omitted. The resolver falls through to its flat 100 g default
and marks the portion assumed — the same treatment every serving-less row gets.

THE ±SD TRAP DOES NOT APPLY TO THIS FILE. IFCT publishes values as `61.78±0.85`,
which breaks naive float parsing. index.csv has already split those into a value
column and a separate `_e` (standard deviation) column, so the values here are
plain floats. If you ever switch to a different IFCT transcription, re-check
this — the parse below assumes clean floats and will reject anything else
rather than silently coerce it.

PER-ROW ATWATER GATE: the source passes vetting comfortably (528 rows, median
deviation 2.50%, 98.7% within 15%), but source-level vetting does not catch
individual bad rows. `Chicken, poultry, leg, skinless` states 1,605 kJ where
its own macros reconcile to ~801 and its siblings (thigh 836, breast 704, wing
807) agree with the macros — a ~2x overstatement on a food Indian users log
often. Rows deviating more than ATWATER_MAX_DEVIATION are dropped and reported
on stderr. The threshold sits well clear of the honest tail (p90 is 9.3%), so
it removes errors rather than trimming the distribution.

It also drops a few rows whose energy is real but un-modellable by Atwater —
`Lemon, juice` (organic acids carry energy Atwater does not count) and crab.
That is the intended trade: a missing row surfaces as "couldn't identify",
which the user can correct, whereas a wrong row surfaces as a confident number
they have no reason to doubt. Those foods remain available from AFCD/USDA.
"""

import csv
import json
import sys

# Kilojoules per kilocalorie (thermochemical), the factor IFCT's own tables use.
KJ_PER_KCAL = 4.184

# Maximum tolerated disagreement between stated energy and 4*carbs + 4*protein
# + 9*fat, as a percentage of stated energy. See PER-ROW ATWATER GATE above.
ATWATER_MAX_DEVIATION = 25.0


def parse_float(value):
    """Return value as a float, or None if it is blank or not a clean number.

    Deliberately strict: anything unparseable returns None and the caller drops
    the row. Coercing junk to 0.0 here would put a 0 kcal food in the index,
    which reads as a real measurement rather than as missing data.
    """
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def convert(csv_path):
    """Convert IFCT index.csv into ingest rows, plus a report of what was dropped."""
    with open(csv_path, newline="", encoding="utf-8") as handle:
        source_rows = list(csv.DictReader(handle))

    rows = []
    dropped_incomplete = []
    dropped_atwater = []

    for source in source_rows:
        name = (source.get("name") or "").strip()
        energy_kj = parse_float(source.get("enerc"))
        protein = parse_float(source.get("protcnt"))
        carbs = parse_float(source.get("choavldf"))
        fat = parse_float(source.get("fatce"))
        fiber = parse_float(source.get("fibtg"))

        if not name or energy_kj is None or energy_kj <= 0:
            dropped_incomplete.append(name or source.get("code", "?"))
            continue
        if protein is None or carbs is None or fat is None:
            dropped_incomplete.append(name)
            continue

        kcal = energy_kj / KJ_PER_KCAL
        atwater = 4 * carbs + 4 * protein + 9 * fat
        deviation = abs(atwater - kcal) / kcal * 100
        if deviation > ATWATER_MAX_DEVIATION:
            dropped_atwater.append((name, round(kcal, 1), round(atwater, 1), round(deviation, 1)))
            continue

        row = {
            "name": name,
            "kcal_per_100g": round(kcal, 2),
            "protein_per_100g": round(protein, 2),
            "carbs_per_100g": round(carbs, 2),
            "fat_per_100g": round(fat, 2),
        }
        # Fibre is genuinely absent for some rows; omit rather than assert 0.
        if fiber is not None:
            row["fiber_per_100g"] = round(fiber, 2)
        rows.append(row)

    return rows, dropped_incomplete, dropped_atwater


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: ifct_convert.py <path-to-ifct-index.csv>")

    rows, dropped_incomplete, dropped_atwater = convert(sys.argv[1])

    print(f"ifct_convert: {len(rows)} rows emitted", file=sys.stderr)
    print(f"ifct_convert: {len(dropped_incomplete)} dropped, incomplete", file=sys.stderr)
    print(
        f"ifct_convert: {len(dropped_atwater)} dropped, Atwater deviation "
        f"> {ATWATER_MAX_DEVIATION}%",
        file=sys.stderr,
    )
    for name, kcal, atwater, deviation in dropped_atwater:
        print(
            f"  {name}: stated {kcal} kcal, macros imply {atwater} ({deviation}% off)",
            file=sys.stderr,
        )

    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
