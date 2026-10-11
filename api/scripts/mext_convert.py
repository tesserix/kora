#!/usr/bin/env python3
"""Convert Japan's official English Standard Tables 2015 workbook.

Usage: mext_convert.py <xlsx>.
Source: https://www.mext.go.jp/en/policy/science_technology/policy/title01/detail01/sdetail01/sdetail01/1385122.htm
MEXT Public Data License (compatible with CC BY 4.0), with attribution.
Parenthesized numbers are source estimates; Tr and '-' are unknown.
"""

import json
import sys
import unicodedata
from pathlib import Path

import openpyxl

from nutrients import reference_food


CORE = {
    "kcal": "energy (kcal)",
    "protein": "protein, calculated from reference nitrogen",
    "carbs": "carbohydrate, total, calculated by difference",
    "fat": "lipid",
    "fiber": "dietary fiber, total",
}
FIELDS = {
    "saturated_fat_per_100g": ("fatty acid, saturated", 1),
    "cholesterol_mg_per_100g": ("cholesterol", 1),
    "sodium_mg_per_100g": ("sodium", 1),
    "calcium_mg_per_100g": ("calcium", 1),
    "iron_mg_per_100g": ("iron", 1),
    "potassium_mg_per_100g": ("potassium", 1),
    "magnesium_mg_per_100g": ("magnesium", 1),
    "phosphorus_mg_per_100g": ("phosphorus", 1),
    "zinc_mg_per_100g": ("zinc", 1),
    "selenium_ug_per_100g": ("selenium", 1),
    "iodine_ug_per_100g": ("iodine", 1),
    "vitamin_a_rae_ug_per_100g": ("retinol activity equivalents", 1),
    "vitamin_c_mg_per_100g": ("ascorbic acid", 1),
    "vitamin_d_ug_per_100g": ("vitamin d", 1),
    "vitamin_e_mg_per_100g": ("alpha-tocopherol", 1),
    "vitamin_k_ug_per_100g": ("vitamin k", 1),
    "thiamin_mg_per_100g": ("thiamin", 1),
    "riboflavin_mg_per_100g": ("riboflavin", 1),
    "niacin_mg_per_100g": ("niacin", 1),
    "vitamin_b6_mg_per_100g": ("vitamin b-6", 1),
    "vitamin_b12_ug_per_100g": ("vitamin b-12", 1),
    "folate_ug_per_100g": ("folate", 1),
}


def normalize(value: object) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value)).lower().split())


def convert(path: str | Path) -> list[dict[str, object]]:
    w = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = w["Table"].iter_rows(min_row=6, values_only=True)
        header = [normalize(v) for v in next(rows)]
        next(rows)
        units = next(rows)
        required = {"food and description", *CORE.values()}
        if not required.issubset(header):
            raise ValueError("MEXT columns changed")
        for field, (label, _) in FIELDS.items():
            if label in header:
                unit = "µg" if "_ug_" in field else "mg" if "_mg_" in field else "g"
                if normalize(units[header.index(label)]) != normalize(f"{unit}/100 g"):
                    raise ValueError(f"MEXT unit changed for {label}")
        output: list[dict[str, object]] = []
        for row in rows:
            source = {
                label: str(value).strip().removeprefix("(").removesuffix(")")
                if value is not None
                else None
                for label, value in zip(header, row)
            }
            source.update({key: source.get(label) for key, label in CORE.items()})
            name = " ".join(str(source.get("food and description") or "").split())
            item = reference_food(name, "JP", source, FIELDS)
            if item is not None:
                output.append(item)
        return sorted(output, key=lambda row: str(row["name"]))
    finally:
        w.close()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    rows = convert(sys.argv[1])
    json.dump(rows, sys.stdout, indent=1, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")
    print(f"mext_convert: {len(rows)} foods", file=sys.stderr)


if __name__ == "__main__":
    main()
