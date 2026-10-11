#!/usr/bin/env python3
"""Convert the official UK CoFID 2021 workbook. Usage: cofid_convert.py <xlsx>.

Source: https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid
Open Government Licence v3.0. Join on food code; RE is not RAE, and AOAC
fibre is not NSP. Trace and unavailable values remain unknown.
"""

import json
import sys
from pathlib import Path

import openpyxl

from nutrients import reference_food


FIELDS = {
    "sugar_per_100g": ("TOTSUG", 1),
    "saturated_fat_per_100g": ("SATFOD", 1),
    "cholesterol_mg_per_100g": ("CHOL", 1),
    "sodium_mg_per_100g": ("NA", 1),
    "calcium_mg_per_100g": ("CA", 1),
    "iron_mg_per_100g": ("FE", 1),
    "potassium_mg_per_100g": ("K", 1),
    "magnesium_mg_per_100g": ("MG", 1),
    "phosphorus_mg_per_100g": ("P", 1),
    "zinc_mg_per_100g": ("ZN", 1),
    "selenium_ug_per_100g": ("SE", 1),
    "iodine_ug_per_100g": ("I", 1),
    "vitamin_a_re_ug_per_100g": ("RETEQU", 1),
    "vitamin_c_mg_per_100g": ("VITC", 1),
    "vitamin_d_ug_per_100g": ("VITD", 1),
    "vitamin_e_mg_per_100g": ("VITE", 1),
    "vitamin_k_ug_per_100g": ("VITK1", 1),
    "thiamin_mg_per_100g": ("THIA", 1),
    "riboflavin_mg_per_100g": ("RIBO", 1),
    "niacin_mg_per_100g": ("NIAC", 1),
    "vitamin_b6_mg_per_100g": ("VITB6", 1),
    "vitamin_b12_ug_per_100g": ("VITB12", 1),
    "folate_ug_per_100g": ("FOLT", 1),
}
CORE = {
    "kcal": "KCALS",
    "protein": "PROT",
    "carbs": "CHO",
    "fat": "FAT",
    "fiber": "AOACFIB",
}


def convert(path: str | Path) -> list[dict[str, object]]:
    w = openpyxl.load_workbook(path, read_only=True, data_only=True)
    foods: dict[str, dict[str, object]] = {}
    try:
        for name in ("1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"):
            sheet = w[name]
            rows = sheet.iter_rows(values_only=True)
            labels, codes = next(rows), next(rows)
            if name == "1.3 Proximates" and not set(CORE.values()).issubset(codes):
                raise ValueError("CoFID proximate columns changed")
            for field, (code, _) in FIELDS.items():
                if code in codes:
                    unit = "µg" if "_ug_" in field else "mg" if "_mg_" in field else "g"
                    if not str(labels[codes.index(code)]).endswith(f"({unit})"):
                        raise ValueError(f"CoFID unit changed for {code}")
            for row in rows:
                if not row[0] or not row[1]:
                    continue
                food = foods.setdefault(str(row[0]), {"name": str(row[1]).strip()})
                food.update(
                    {str(code): value for code, value in zip(codes, row) if code}
                )
        output: list[dict[str, object]] = []
        for food in foods.values():
            food.update({key: food.get(code) for key, code in CORE.items()})
            item = reference_food(str(food["name"]), "GB", food, FIELDS)
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
    print(f"cofid_convert: {len(rows)} foods", file=sys.stderr)


if __name__ == "__main__":
    main()
