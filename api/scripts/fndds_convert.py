#!/usr/bin/env python3
"""Convert USDA FNDDS survey foods to the ingest JSON shape.

    curl -sSLo fndds.zip -A "Mozilla/5.0" \
      https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip
    unzip fndds.zip && python3 scripts/fndds_convert.py \
      FoodData_Central_survey_food_csv_2024-10-31 > data/food/usda_fndds.json

FNDDS is USDA's survey database of foods AS CONSUMED — the US counterpart of
AUSNUT (see ausnut_convert.py): ~5,400 prepared foods with measured portion
weights, where SR Legacy is per-100 g reference data frozen since 2018. USDA
publishes a new FNDDS release roughly every two years; rerun this then.

FDC data is public domain (CC0), so there is no attribution obligation.

Like the other converters this is a data-prep step run by hand whose OUTPUT is
committed; nothing in the build or deploy depends on this file.
"""

import csv
import json
import os
import re
import sys

# FNDDS food_nutrient rows use the legacy nutrient numbers, not FDC ids.
NUTRIENTS = {"208": "kcal", "203": "protein", "205": "carbs", "204": "fat", "291": "fiber"}

# Same plausibility bar as off_convert.py: nothing edible beats pure fat.
MAX_KCAL_PER_100G = 900
# Matches plausibleServingGrams in internal/ai/portion.go, like the other
# converters — a serving this file accepts but the resolver rejects would show
# a portion the diary then disagrees with.
MIN_SERVING_G = 1
MAX_SERVING_G = 500

# "1 cup", "2 tablespoons", "0.25 stick" → (amount, unit noun).
PORTION_RE = re.compile(r"^(\d+(?:\.\d+)?)\s+(.+)$")


def read_rows(directory, name):
    with open(os.path.join(directory, name), newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: fndds_convert.py <extracted FNDDS csv directory>")
    directory = sys.argv[1]

    foods = {
        r["fdc_id"]: r["description"].strip()
        for r in read_rows(directory, "food.csv")
        if r["data_type"] == "survey_fndds_food" and r["description"].strip()
    }

    nutrition = {}
    for r in read_rows(directory, "food_nutrient.csv"):
        field = NUTRIENTS.get(r["nutrient_id"])
        if field is None or r["fdc_id"] not in foods:
            continue
        try:
            nutrition.setdefault(r["fdc_id"], {})[field] = float(r["amount"])
        except ValueError:
            continue

    portions = {}
    for r in read_rows(directory, "food_portion.csv"):
        if r["fdc_id"] not in foods:
            continue
        try:
            grams = float(r["gram_weight"])
            seq = int(r["seq_num"] or 0)
        except ValueError:
            continue
        desc = r["portion_description"].strip()
        m = PORTION_RE.match(desc)
        # "Quantity not specified" and other unparseable measures carry no
        # name a user's phrase could match; storing them helps nothing.
        if not m or not (MIN_SERVING_G <= grams <= MAX_SERVING_G):
            continue
        portions.setdefault(r["fdc_id"], []).append(
            {"seq": seq, "desc": desc, "name": m.group(2), "amount": float(m.group(1)), "grams": grams}
        )

    kept, dropped_incomplete, dropped_implausible = [], 0, 0
    for fdc_id, name in sorted(foods.items(), key=lambda kv: kv[1].lower()):
        n = nutrition.get(fdc_id, {})
        # All four macros required, as everywhere else: a row without them
        # cannot answer a nutrition question but can still win a name match.
        if any(k not in n for k in ("kcal", "protein", "carbs", "fat", "fiber")):
            dropped_incomplete += 1
            continue
        if not (0 <= n["kcal"] <= MAX_KCAL_PER_100G):
            dropped_implausible += 1
            continue
        if any(not (0 <= n[k] <= 100) for k in ("protein", "carbs", "fat", "fiber")):
            dropped_implausible += 1
            continue
        if n["protein"] + n["carbs"] + n["fat"] > 100:
            dropped_implausible += 1
            continue

        entry = {
            "name": name,
            "kcal_per_100g": round(n["kcal"], 1),
            "protein_per_100g": round(n["protein"], 2),
            "carbs_per_100g": round(n["carbs"], 2),
            "fat_per_100g": round(n["fat"], 2),
            "fiber_per_100g": round(n["fiber"], 2),
        }
        units = sorted(portions.get(fdc_id, []), key=lambda p: p["seq"])
        if units:
            entry["serving_units"] = [
                {"name": u["name"], "amount": u["amount"], "base_amount": round(u["grams"], 1)}
                for u in units
            ]
            # seq_num 1 is the measure survey respondents reported in most —
            # FNDDS's own primary — so unlike AUSNUT there is no ambiguity to
            # abstain from.
            primary = units[0]
            entry["serving_grams"] = round(primary["grams"], 1)
            entry["serving_desc"] = primary["desc"]
        kept.append(entry)

    json.dump(kept, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")
    print(
        f"fndds_convert: {len(foods)} survey foods, kept {len(kept)} "
        f"(incomplete {dropped_incomplete}, implausible {dropped_implausible})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
