#!/usr/bin/env python3
"""Convert AUSNUT 2023 to the ingest schema — Australian foods AS CONSUMED.

    python3 scripts/ausnut_convert.py "AUSNUT 2023 - Food nutrient profiles.xlsx" > data/food/ausnut.json

Source: https://www.foodstandards.gov.au/science-data/food-nutrient-databases/ausnut/data-files
        "AUSNUT 2023 - Food nutrient profiles.xlsx", sheet "Food nutrient profiles".

Same publisher as AFCD (FSANZ), so the same terms already accepted for
afcd_release3.json. Like that converter this is Python rather than Go purely
because xlsx parsing would otherwise add an Excel dependency to the API module
for a step that runs by hand every few years, and the generated JSON is
committed so neither the build nor the deploy needs this script.

WHY THIS EXISTS, separately from AFCD: AFCD is a composition database — foods
as INGREDIENTS, measured in a lab. AUSNUT is the national nutrition survey's
database of foods AS CONSUMED, which is where Australian takeaway lives. The
index had exactly EIGHT outlet-style Australian rows before this, all of them
AFCD strays in AUSNUT's own naming style ("Potato, chips, regular, fast food
outlet, deep fried, blended oil, salted"). AUSNUT is where the rest are: 53
"takeaway", 35 "fast food", 32 "chain", 20 "outlet" and 439 "commercial" foods —
Chiko rolls, dim sims, takeaway pizza by topping and base, battered fish.

WHAT IT DOES NOT SOLVE: AUSNUT names survey categories, not brands. It has
"Pizza, meat & vegetable (e.g. supreme), takeaway" but never "Domino's Supreme",
and nothing will make it answer "El Janah" or "Nando's". Brand-level menu data
is a separate, per-chain problem.

ENERGY IS KILOJOULES, and this uses "Energy WITH dietary fibre" — the figure
Australian nutrition information panels are calculated on, matching
afcd_convert.py so the two Australian sources share one convention.

CARBOHYDRATE: "Available carbohydrate, with sugar alcohols", again matching
AFCD. It excludes dietary fibre, unlike USDA's "carbohydrate by difference".

ATWATER VETTING — the source passes comfortably, and the model matters:

    plain 4/4/9          median 2.31%, 90.7% within 15%
    AU convention        median 1.01%, 99.1% within 15%, p90 2.9%

The AU model adds dietary fibre at 8 kJ/g and alcohol at 29 kJ/g, which is how
FSANZ computes the energy column. Running both is what PROVES the convention
rather than assuming it: if the fibre/alcohol terms were wrong, the second model
would not have improved on the first.

NO ROWS ARE DROPPED FOR ATWATER DEVIATION, which differs from
ifct_convert.py — deliberately, and on evidence. Only 4 of 3,741 rows fail both
a >25% and a >20 kcal absolute gate, and all four are polyol-sweetened
(xylitol, erythritol, "no added sugar" lollies and marshmallow). For those the
STATED value is right and Atwater is wrong, because polyols carry energy but do
not appear in "available carbohydrate". IFCT's dropped chicken row was the
opposite case — genuinely wrong, proved by its own siblings disagreeing. The
check is for catching fabricated data, not for deleting real food our formula
cannot model.

NO SERVING SIZES: AUSNUT publishes them in a separate "Food measures" file
(9,816 measures). Not used here — the resolver falls through to its flat 100 g
default and marks the portion assumed, the same treatment every serving-less row
already gets. Wiring measures up is a worthwhile follow-up.
"""

import json
import sys

import openpyxl

SHEET = "Food nutrient profiles"
HEADER_ROW = 3  # 1-indexed; rows 1-2 are the title block

# Kilojoules per kilocalorie.
KJ_PER_KCAL = 4.184

# Column indices, verified against the header row below rather than trusted.
COL = {
    "name": 3,
    "energy_kj": 4,  # with dietary fibre
    "protein": 7,
    "fat": 8,
    "carbs": 9,  # available carbohydrate, with sugar alcohols
    "fiber": 15,
    "alcohol": 16,
}

EXPECTED = {
    "name": "food name",
    "energy_kj": "energy with dietary fibre",
    "protein": "protein",
    "fat": "total fat",
    "carbs": "available carbohydrate, with sugar alcohols",
    "fiber": "dietary fibre",
    "alcohol": "alcohol",
}


def check_headers(header_row):
    """Fail loudly if the sheet's columns have moved.

    A silently shifted column would publish one nutrient's values under another
    nutrient's name, which no downstream check would catch.
    """
    for field, index in COL.items():
        actual = str(header_row[index] or "").strip().lower()
        if not actual.startswith(EXPECTED[field]):
            raise SystemExit(
                f"ausnut_convert: column {index} is {actual!r}, expected it to start with "
                f"{EXPECTED[field]!r}. The sheet layout changed — re-check COL before trusting output."
            )


def number(value):
    """Coerce a cell to a float, treating blanks and junk as 0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def convert(path):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[SHEET]
    rows = sheet.iter_rows(min_row=HEADER_ROW, values_only=True)
    check_headers(next(rows))

    out = []
    for row in rows:
        name = str(row[COL["name"]] or "").strip()
        if not name:
            continue
        kcal = number(row[COL["energy_kj"]]) / KJ_PER_KCAL
        # Only negative energy is rejected. Zero is a real measurement — water,
        # black tea, diet soft drink — and dropping it is what removed every
        # zero-energy food from the index once already.
        if kcal < 0:
            continue
        out.append(
            {
                "name": name,
                "kcal_per_100g": round(kcal, 1),
                "protein_per_100g": round(number(row[COL["protein"]]), 1),
                "carbs_per_100g": round(number(row[COL["carbs"]]), 1),
                "fat_per_100g": round(number(row[COL["fat"]]), 1),
                "fiber_per_100g": round(number(row[COL["fiber"]]), 1),
            }
        )
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: ausnut_convert.py <AUSNUT-2023-Food-nutrient-profiles.xlsx>")
    rows = convert(sys.argv[1])
    print(f"ausnut_convert: {len(rows)} rows emitted", file=sys.stderr)
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
