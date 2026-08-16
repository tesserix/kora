#!/usr/bin/env python3
"""Convert the FSANZ Australian Food Composition Database to the ingest schema.

    python3 scripts/afcd_convert.py <nutrient-profiles.xlsx> > data/food/afcd_release3.json

Source: https://www.foodstandards.gov.au/science-data/food-nutrient-databases/afcd/data-files
        "AFCD Release 3 - Nutrient profiles.xlsx", sheet "All solids & liquids per 100 g".

A Python script rather than a Go tool (cf. cmd/srconvert) purely because xlsx
parsing would otherwise add an Excel dependency to the API module for a step
that runs by hand every few YEARS — AFCD Release 3 succeeded Release 2 after a
multi-year gap. The generated JSON is committed, exactly as
data/food/usda_sr_legacy.json is, so nothing in the build or the deploy needs
this script or openpyxl.

WHY THIS EXISTS: data/food/afcd_staples.json holds 20 hand-written rows, and
they were essentially all the Australian content in an index of ~7,900
(kora#184). The rest is USDA, so an Australian user's everyday foods resolved
to US rows — "chips" to "potato chips without salt", a McDonald's item to a
Bacon Ranch Salad. Release 3 carries 1,588 foods measured in Australia.

ENERGY: this uses "Energy WITH dietary fibre", the figure Australian nutrition
information panels are calculated on (FSANZ counts dietary fibre at 8 kJ/g).
The alternative column, "without dietary fibre", is closer to the US Atwater
convention the USDA rows in this index already follow. They are chosen
deliberately per-source rather than harmonised: an AFCD row exists so an
Australian food matches the label on the packet in front of the user, and the
gap between the two is only material for high-fibre foods.

CARBOHYDRATE: "Available carbohydrate, with sugar alcohols" — the AU labelling
figure, which excludes dietary fibre. USDA's "carbohydrate by difference"
INCLUDES fibre, so the two conventions differ; again, each row matches the
convention of the label its food would carry.

NO SERVING SIZES: AFCD is per-100 g reference data and states no serving.
serving_grams is therefore omitted, which makes the resolver fall through to its
flat 100 g default AND mark the portion assumed (portionGramsFor in
internal/ai/portion.go) — honest, and the same treatment any serving-less row
already gets.
"""

import json
import sys

import openpyxl

SHEET = "All solids & liquids per 100 g"
HEADER_ROW = 3

# Column indices in the Release 3 sheet. Verified against the header row rather
# than assumed — see check_headers below, which fails loudly if FSANZ reorders
# columns in a future release instead of silently producing wrong nutrition.
COL = {
    "key": 0,
    "name": 3,
    "energy_kj": 4,  # with dietary fibre
    "protein": 7,
    "fat": 9,
    "fiber": 11,
    "carbs": 39,  # available carbohydrate, with sugar alcohols
}

EXPECTED = {
    "key": "public food key",
    "name": "food name",
    "energy_kj": "energy with dietary fibre",
    "protein": "protein",
    "fat": "fat, total",
    "fiber": "total dietary fibre",
    "carbs": "available carbohydrate, with sugar alcohols",
}

# FSANZ states energy in kilojoules; the index stores kcal.
KJ_PER_KCAL = 4.184


def check_headers(header):
    for field, idx in COL.items():
        actual = str(header[idx] or "").replace("\n", " ").strip().lower()
        if not actual.startswith(EXPECTED[field]):
            raise SystemExit(
                f"afcd_convert: column {idx} is {actual!r}, expected {EXPECTED[field]!r}. "
                "FSANZ has changed the layout — remap COL rather than trusting these indices."
            )


def number(value):
    """AFCD leaves a cell blank, or writes a trace marker, where no value exists."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if text in ("", "-", "n/a"):
        return 0.0
    # Trace amounts are written as a bare "<1" style marker; treat as zero rather
    # than guessing a magnitude.
    if text.startswith("<"):
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)

    workbook = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
    sheet = workbook[SHEET]
    rows = sheet.iter_rows(min_row=HEADER_ROW, values_only=True)
    check_headers(next(rows))

    out = []
    for row in rows:
        name = str(row[COL["name"]] or "").strip()
        if not name:
            continue
        kcal = number(row[COL["energy_kj"]]) / KJ_PER_KCAL
        # LoadFile drops rows without a positive kcal anyway; skipping here keeps
        # the committed file free of entries that would never be ingested.
        if kcal <= 0:
            continue
        out.append(
            {
                "name": name,
                "kcal_per_100g": round(kcal, 1),
                "protein_per_100g": round(number(row[COL["protein"]]), 2),
                "carbs_per_100g": round(number(row[COL["carbs"]]), 2),
                "fat_per_100g": round(number(row[COL["fat"]]), 2),
                "fiber_per_100g": round(number(row[COL["fiber"]]), 2),
            }
        )

    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")
    print(f"afcd_convert: {len(out)} foods", file=sys.stderr)


if __name__ == "__main__":
    main()
