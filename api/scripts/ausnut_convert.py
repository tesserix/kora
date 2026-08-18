#!/usr/bin/env python3
"""Convert AUSNUT 2023 to the ingest schema — Australian foods AS CONSUMED.

    python3 scripts/ausnut_convert.py \\
        "AUSNUT 2023 - Food nutrient profiles.xlsx" \\
        "AUSNUT 2023 - Food measures.xlsx" > data/food/ausnut.json

Source: https://www.foodstandards.gov.au/science-data/food-nutrient-databases/ausnut/data-files
        "AUSNUT 2023 - Food nutrient profiles.xlsx", sheet "Food nutrient profiles".
        "AUSNUT 2023 - Food measures.xlsx", sheet "AUSNUT 2023".
        Both are in the "AUSNUT 2023 - All Files" zip on that page.

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

SERVING SIZES come from the separate "Food measures" workbook, joined on
"Public food key". Before this every one of the 3,238 rows reached the index
with no serving at all, so the resolver fell through to its flat 100 g default.

    9,816 measure rows / 3,713 foods
    3,609 are `density` — EXCLUDED, see below
    6,207 real measures / 2,618 foods

DENSITY IS NOT A SERVING. It is g/mL, and it is the single most common
descriptor in the file. Beer's density row is 1.009, so treating measures
uniformly would file a beer as a one-gram serving. Dropped outright.

TWO DIFFERENT OUTPUTS, because the resolver has two different tiers for them:

  serving_units  every real measure, as {name, amount, base_amount}. Feeds the
                 food's OWN named servings, so "1 can" resolves against this
                 row's mass instead of a generic table. No judgement involved.
  serving_grams  ONE default, for when the phrase names no unit at all.

CHOOSING THE PRIMARY — agree or abstain:

  a default is emitted ONLY when every candidate measure names the same mass;
  otherwise the food gets none and falls back to the resolver's flat 100 g

Two earlier rules both shipped wrong answers, in opposite directions:

  smallest            picked one piece of a food eaten in handfuls — "1 pea",
                      "1 leaf", "1 chip" (3.9 g). 213 foods under 5 g, and a
                      plate of hot chips resolving to 7 kcal.
  nearest a typical   picked a cup of a food eaten by the teaspoon —
  portion             `Sauce, tomato` at 260 g where the 10 g packet was right.

A single scalar cannot mean "a portion" for both a sauce and a pizza. Where
AUSNUT lists several genuinely different masses it is describing several
genuinely different servings, and choosing one is a guess. 1,881 foods get an
unambiguous default; 726 get none and are no worse off than before this join
existed.

Abstaining is cheap because `serving_units` still carries EVERY measure, so
"2 slices of pizza" and "3 chips" resolve against the row's own data either
way. Only the bare-phrase default falls back.


`millilitres` is excluded outright rather than demoted — see
UNIT_NAME_DESCRIPTORS. It names a unit rather than a thing, and storing it as
a named serving would make "200 millilitres" resolve to 21,000 g.

Duplicate descriptors within one food (beer has four `can` rows) collapse to
the smallest. The resolver takes the first phrase match, so leaving duplicates
in would make a logged mass depend on spreadsheet row order.

The 1-500 g band mirrors ai.plausibleServingGrams, so a primary this emits is
one the resolver will actually accept rather than silently ignore.
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
    "key": 1,  # Public food key — the join to the measures workbook
    "name": 3,
    "energy_kj": 4,  # with dietary fibre
    "protein": 7,
    "fat": 8,
    "carbs": 9,  # available carbohydrate, with sugar alcohols
    "fiber": 15,
    "alcohol": 16,
}

EXPECTED = {
    "key": "public food key",
    "name": "food name",
    "energy_kj": "energy with dietary fibre",
    "protein": "protein",
    "fat": "total fat",
    "carbs": "available carbohydrate, with sugar alcohols",
    "fiber": "dietary fibre",
    "alcohol": "alcohol",
}

# --- Food measures workbook -------------------------------------------------

MEASURES_SHEET = "AUSNUT 2023"
MEASURES_HEADER_ROW = 3

MCOL = {"key": 1, "name": 2, "quantity": 4, "descriptor": 5, "grams": 9}

MEXPECTED = {
    "key": "public food key",
    "name": "food name",
    "quantity": "quantity",
    "descriptor": "descriptor 1",
    "grams": "gram amount",
}

# g/mL, not a portion. The most common descriptor in the file by far (3,609 of
# 9,816); including it would make beer a 1.009 g serving.
DENSITY = "density"

# Descriptors that name a MEASUREMENT UNIT rather than a thing you eat. AUSNUT
# writes these with Quantity 1 and the portion mass in the gram column, so
# "millilitres" on a cordial row means "a 105 g serve", NOT "one millilitre".
#
# Emitting that as a named serving is actively dangerous, not merely untidy:
# a stored unit called `millilitres` with base_amount 105 makes the resolver
# read "200 millilitres" as 200 x 105 = 21,000 g. Excluded from named servings
# AND from the primary, since there is no honest label to give it either.
#
# `millilitres` (105 rows) is the ONLY such descriptor — checked against all
# 390 distinct descriptors for litre/gram/ounce/kilo/pound/fluid wording.
# Anything similar appearing in a future release must be added here.
UNIT_NAME_DESCRIPTORS = {"millilitres"}

# Real units, but far too small to be a food's DEFAULT serving when it also has
# a cup or a piece. Still emitted as named servings — "2 tablespoons of flour"
# is a perfectly good thing to log — just never chosen as the primary unless
# the food offers nothing else. See the module docstring for the 98 foods this
# was measured against.
SPOON_SCALE = {"teaspoon", "tablespoon", "pinch", "handful"}

# Mirrors ai.plausibleServingGrams. A primary outside this band is one the
# resolver would reject anyway, so emitting it would be writing a value that
# silently does nothing.
MIN_SERVING_G = 1
MAX_SERVING_G = 500

# Absolute floor for a DEFAULT serving. Above the 1 g the resolver tolerates,
# because a default is a different question from a valid unit: "1 pea" is a
# real measure and a useless default.
#
# 5 g, chosen by reading the bands rather than by intuition. Below it sits the
# absurd — pea 1.0, berry 1.2, currant 1.2, banana chip 1.4, plum 1.6. Just
# above it sits the legitimately small — butter packet 7.0, pumpernickel slice
# 7.0, Weet-Bix biscuit 7.5, rice-paper wrapper 8.0 — which a higher floor
# would throw away.
MIN_PRIMARY_SERVING_G = 5


def number(value):
    """Coerce a cell to a float, treating blanks and junk as 0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def check_headers(header_row, columns=None, expected=None, what="COL"):
    """Fail loudly if the sheet's columns have moved.

    A silently shifted column would publish one nutrient's values under another
    nutrient's name, which no downstream check would catch. The measures sheet
    gets the same treatment for the same reason: a shifted gram column would
    quietly file every serving under the wrong mass.
    """
    columns = COL if columns is None else columns
    expected = EXPECTED if expected is None else expected
    for field, index in columns.items():
        actual = str(header_row[index] or "").strip().lower()
        if not actual.startswith(expected[field]):
            raise SystemExit(
                f"ausnut_convert: column {index} is {actual!r}, expected it to start with "
                f"{expected[field]!r}. The sheet layout changed — re-check {what} before trusting output."
            )


def load_measures(path):
    """Read the Food measures workbook into {public food key: [serving unit]}.

    Density rows are dropped, duplicate descriptors collapse to the smallest,
    and the result keeps AUSNUT's own row order so output is stable across runs.
    """
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[MEASURES_SHEET]
    rows = sheet.iter_rows(min_row=MEASURES_HEADER_ROW, values_only=True)
    check_headers(next(rows), MCOL, MEXPECTED, what="MCOL")

    by_food = {}
    for row in rows:
        key = str(row[MCOL["key"]] or "").strip()
        descriptor = str(row[MCOL["descriptor"]] or "").strip().lower()
        if not key or not descriptor:
            continue
        if descriptor == DENSITY or descriptor in UNIT_NAME_DESCRIPTORS:
            continue
        grams = number(row[MCOL["grams"]])
        quantity = number(row[MCOL["quantity"]])
        if grams <= 0 or quantity <= 0:
            continue
        # Per-unit mass is what makes two measures of the same descriptor
        # comparable — a "2 biscuit, 30 g" entry is 15 g a biscuit, not 30.
        per_unit = grams / quantity
        existing = by_food.setdefault(key, {})
        if descriptor not in existing or per_unit < existing[descriptor]["base_amount"]:
            existing[descriptor] = {
                "name": descriptor,
                "amount": 1,
                "base_amount": round(per_unit, 1),
            }
    return {key: list(units.values()) for key, units in by_food.items()}


def primary_serving(serving_units):
    """Pick the ONE default serving, or None when the measures disagree.

    AGREE OR ABSTAIN. A default is only emitted when every candidate measure
    points at the same mass; otherwise the food gets no default and falls back
    to the resolver's flat 100 g, exactly as it did before measures existed.

    Two rules were tried and BOTH shipped wrong answers, in opposite
    directions, which is why this one refuses to guess:

      smallest          picked one piece of a food eaten in handfuls.
                        "1 pea", "1 leaf", "1 chip" (3.9 g) — 213 foods under
                        5 g, and a plate of hot chips resolving to 7 kcal.

      nearest a typical picked a cup of a food eaten by the teaspoon.
      portion (150 g)   `Sauce, tomato` -> "1 cup" 260 g, where the packet at
                        10 g was right. Overstating a condiment 26x is no
                        better than understating chips.

    The failures share a cause: a single scalar cannot express "a portion" for
    both a sauce and a pizza. Where AUSNUT lists several genuinely different
    masses it is describing several genuinely different servings, and picking
    one is a guess. So this abstains — 1,881 foods get an unambiguous default,
    726 get none.

    Abstaining costs little, because `serving_units` still carries EVERY
    measure. "2 slices of pizza" and "3 chips" resolve against the row's own
    data regardless; only the bare-phrase default falls back.

    Candidates exclude spoon-scale descriptors (the 98 tablespoon-beside-a-cup
    foods) and anything under MIN_PRIMARY_SERVING_G. Descriptors that merely
    name the same mass twice — beer's `can` and `bottle` are both 333 g — are
    NOT a disagreement, so beer keeps its stubby.
    """
    candidates = [
        u
        for u in serving_units
        if MIN_PRIMARY_SERVING_G <= u["base_amount"] <= MAX_SERVING_G
        and u["name"] not in SPOON_SCALE
    ]
    if not candidates:
        return None
    if len({u["base_amount"] for u in candidates}) != 1:
        return None
    return min(candidates, key=lambda u: u["name"])


def convert(path, measures_path):
    measures = load_measures(measures_path)
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[SHEET]
    rows = sheet.iter_rows(min_row=HEADER_ROW, values_only=True)
    check_headers(next(rows))

    out = []
    matched = 0
    for row in rows:
        name = str(row[COL["name"]] or "").strip()
        if not name:
            continue
        serving_units = measures.get(str(row[COL["key"]] or "").strip(), [])
        kcal = number(row[COL["energy_kj"]]) / KJ_PER_KCAL
        # Only negative energy is rejected. Zero is a real measurement — water,
        # black tea, diet soft drink — and dropping it is what removed every
        # zero-energy food from the index once already.
        if kcal < 0:
            continue
        entry = {
            "name": name,
            "kcal_per_100g": round(kcal, 1),
            "protein_per_100g": round(number(row[COL["protein"]]), 1),
            "carbs_per_100g": round(number(row[COL["carbs"]]), 1),
            "fat_per_100g": round(number(row[COL["fat"]]), 1),
            "fiber_per_100g": round(number(row[COL["fiber"]]), 1),
        }
        # Serving fields are omitted entirely when a food has no measure, so
        # the emitted row is identical to what this script produced before the
        # measures join. That keeps "no serving data" as an absence rather than
        # a zero the loader would have to special-case.
        if serving_units:
            matched += 1
            entry["serving_units"] = serving_units
            primary = primary_serving(serving_units)
            if primary:
                entry["serving_grams"] = primary["base_amount"]
                entry["serving_desc"] = f"1 {primary['name']}"
        out.append(entry)
    print(
        f"ausnut_convert: {matched} of {len(out)} rows matched a measure",
        file=sys.stderr,
    )
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(
            "usage: ausnut_convert.py <AUSNUT-2023-Food-nutrient-profiles.xlsx> "
            "<AUSNUT-2023-Food-measures.xlsx>"
        )
    rows = convert(sys.argv[1], sys.argv[2])
    print(f"ausnut_convert: {len(rows)} rows emitted", file=sys.stderr)
    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
