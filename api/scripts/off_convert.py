#!/usr/bin/env python3
"""Filter the OpenFoodFacts CSV export down to usable products per country.

    curl -sSL https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz \
      | gunzip -c | python3 scripts/off_convert.py --countries au,nz,in --outdir data/food

Reads the export on STDIN so the 1.19 GB download is never written to disk, and
emits every requested country in the same single pass (off_au.json, off_nz.json,
off_in.json). Each row is stamped with its country's locale, which is what lets
nutrition.DeriveLocale keep a single provenance for OFF: the per-row locale from
this file wins, exactly as au_in_dishes.json's does.

A product sold in several requested countries lands in each country's file; at
ingest the alphabetically-first file wins the name+brand collision (see
ingest.Run), so a trans-Tasman product resolves with locale AU. That is the
right loss: the nutrition is identical, only the boost differs.

## Licence — ODbL

OpenFoodFacts data is published under the Open Database License. Using it
obliges Kora to **attribute OpenFoodFacts**, and to release any derived DATABASE
it publicly distributes under the same terms. Serving query results to app users
is a "produced work" rather than distributing the database, but the attribution
requirement is unconditional and must appear in the app.

## Why filter hard rather than take all 78,680

OFF is community-maintained and its long tail is thin: entries with a name and
nothing else, duplicates, and products whose nutrition was never filled in. Those
rows cannot answer a nutrition question, but they CAN win a name match and
displace a row that could — so importing them would trade coverage for accuracy,
which is the wrong direction for kora#184.

The bar below is "this row could actually answer 'how many calories was that'":
a name, a plausible energy figure, and all four macros. A product that clears it
is worth having; one that does not is noise in the index.

## Why a Python script (cf. scripts/afcd_convert.py)

Same reason: a data-prep step run by hand, whose OUTPUT is committed. Nothing in
the build, the tests or the deploy depends on this file.
"""

import argparse
import csv
import json
import os
import sys

# Country slug → (OFF countries_tags entry, row locale, output file). The
# locale values must match the nutrition.Locale constants; the filenames must
# match ingest/sources.go.
COUNTRIES = {
    "au": ("en:australia", "AU", "off_au.json"),
    "nz": ("en:new-zealand", "NZ", "off_nz.json"),
    "in": ("en:india", "IN", "off_in.json"),
}

# 0-indexed positions in the export's 211-column tab-separated header.
# Verified against the header row at runtime — see check_header, which fails
# loudly rather than silently importing the wrong nutrient into a health app.
COL = {
    "code": 0,
    "product_name": 10,
    "brands": 18,
    "countries_tags": 40,
    "serving_quantity": 51,
    "kcal": 89,
    "fat": 92,
    "carbs": 129,
    "fiber": 146,
    "protein": 150,
}

EXPECTED = {
    "code": "code",
    "product_name": "product_name",
    "brands": "brands",
    "countries_tags": "countries_tags",
    "serving_quantity": "serving_quantity",
    "kcal": "energy-kcal_100g",
    "fat": "fat_100g",
    "carbs": "carbohydrates_100g",
    "fiber": "fiber_100g",
    "protein": "proteins_100g",
}

# Nothing edible exceeds pure fat, which is ~900 kcal/100 g. A figure above that
# is a unit error (kJ recorded in a kcal column) or a typo, not a food.
MAX_KCAL_PER_100G = 900

# Bounds on a stored serving, matching plausibleServingGrams in
# internal/ai/portion.go and initialPortionFor in the mobile app. Kept in step
# deliberately: a serving this file accepts but the resolver rejects would show
# the user a portion the diary then disagrees with.
MIN_SERVING_G = 1
MAX_SERVING_G = 500


def check_header(header):
    for field, idx in COL.items():
        if idx >= len(header) or header[idx] != EXPECTED[field]:
            actual = header[idx] if idx < len(header) else "<out of range>"
            raise SystemExit(
                f"off_convert: column {idx} is {actual!r}, expected {EXPECTED[field]!r}. "
                "OpenFoodFacts has changed the export layout — remap COL."
            )


def number(text):
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--countries", default="au",
                    help="comma-separated country slugs: " + ",".join(COUNTRIES))
    ap.add_argument("--outdir", default="data/food",
                    help="directory the per-country JSON files are written to")
    args = ap.parse_args()
    slugs = [s.strip() for s in args.countries.split(",") if s.strip()]
    unknown = [s for s in slugs if s not in COUNTRIES]
    if unknown:
        raise SystemExit(f"off_convert: unknown countries {unknown}; know {sorted(COUNTRIES)}")

    reader = csv.reader(sys.stdin, delimiter="\t", quoting=csv.QUOTE_NONE)
    check_header(next(reader))

    kept = {s: [] for s in slugs}
    seen = {s: set() for s in slugs}
    scanned = dropped_no_country = dropped_incomplete = dropped_implausible = dropped_dupe = 0

    for row in reader:
        scanned += 1
        if len(row) <= COL["protein"]:
            dropped_incomplete += 1
            continue

        tags = row[COL["countries_tags"]]
        matched = [s for s in slugs if COUNTRIES[s][0] in tags]
        if not matched:
            dropped_no_country += 1
            continue

        name = row[COL["product_name"]].strip()
        if not name or len(name) > 120:
            dropped_incomplete += 1
            continue

        kcal = number(row[COL["kcal"]])
        macros = {k: number(row[COL[k]]) for k in ("protein", "carbs", "fat", "fiber")}
        # All four macros required, not just energy: a row without them cannot
        # answer a nutrition question, and an incomplete row that wins a name
        # match is worse than no row at all.
        if kcal is None or any(v is None for v in macros.values()):
            dropped_incomplete += 1
            continue

        if not (0 < kcal <= MAX_KCAL_PER_100G):
            dropped_implausible += 1
            continue
        # Per 100 g, no single macro can exceed 100 g, and they cannot sum past
        # it either. Both happen in community data.
        if any(not (0 <= v <= 100) for v in macros.values()):
            dropped_implausible += 1
            continue
        if macros["protein"] + macros["carbs"] + macros["fat"] > 100:
            dropped_implausible += 1
            continue

        brand = row[COL["brands"]].strip().split(",")[0].strip()
        key = (name.lower(), brand.lower())

        item = {
            "name": name,
            "brand": brand,
            "kcal_per_100g": round(kcal, 1),
            "protein_per_100g": round(macros["protein"], 2),
            "carbs_per_100g": round(macros["carbs"], 2),
            "fat_per_100g": round(macros["fat"], 2),
            "fiber_per_100g": round(macros["fiber"], 2),
        }

        serving = number(row[COL["serving_quantity"]])
        if serving is not None and MIN_SERVING_G <= serving <= MAX_SERVING_G:
            item["serving_grams"] = round(serving, 1)

        # The barcode is why this source is worth more than its rows alone: it
        # feeds the scan path directly (internal/nutrition/barcode.go).
        code = row[COL["code"]].strip()
        if code.isdigit() and 8 <= len(code) <= 14:
            item["barcode"] = code

        placed = False
        for slug in matched:
            if key in seen[slug]:
                continue
            seen[slug].add(key)
            kept[slug].append({**item, "locale": COUNTRIES[slug][1]})
            placed = True
        if not placed:
            dropped_dupe += 1

    for slug in slugs:
        path = os.path.join(args.outdir, COUNTRIES[slug][2])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(kept[slug], f, indent=1, ensure_ascii=False)
            f.write("\n")
        print(f"off_convert: {path} kept {len(kept[slug])}", file=sys.stderr)
    print(
        f"off_convert: scanned {scanned} "
        f"(no requested country {dropped_no_country}, incomplete {dropped_incomplete}, "
        f"implausible {dropped_implausible}, duplicate {dropped_dupe})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
