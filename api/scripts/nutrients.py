"""Optional per-100 g measurements shared by the offline converters."""

import math
from collections.abc import Mapping, Sequence


def measurement(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    if (
        not text
        or text.lower() in {"tr", "trace", "n", "n/a", "-", "nan"}
        or text.startswith("<")
    ):
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) and number >= 0 else None


def optional_nutrients(
    source: Mapping[str, object], fields: Mapping[str, tuple[str, float]]
) -> dict[str, float]:
    result = {}
    for output, (column, scale) in fields.items():
        value = measurement(source.get(column))
        maximum = 100000000 if "_ug_" in output else 100000 if "_mg_" in output else 100
        if value is not None and value * scale <= maximum:
            result[output] = round(value * scale, 4)
    return result


FSANZ_FIELDS = {
    "sugar_per_100g": ("total sugars (g)",),
    "saturated_fat_per_100g": (
        "total saturated fatty acids, equated (g)",
        "total saturated fat (g)",
    ),
    "cholesterol_mg_per_100g": ("cholesterol (mg)",),
    "sodium_mg_per_100g": ("sodium (na) (mg)",),
    "calcium_mg_per_100g": ("calcium (ca) (mg)",),
    "iron_mg_per_100g": ("iron (fe) (mg)",),
    "potassium_mg_per_100g": ("potassium (k) (mg)",),
    "magnesium_mg_per_100g": ("magnesium (mg) (mg)",),
    "phosphorus_mg_per_100g": ("phosphorus (p) (mg)",),
    "zinc_mg_per_100g": ("zinc (zn) (mg)",),
    "selenium_ug_per_100g": ("selenium (se) (ug)",),
    "iodine_ug_per_100g": ("iodine (i) (ug)",),
    "vitamin_a_re_ug_per_100g": ("vitamin a retinol equivalents (ug)",),
    "vitamin_c_mg_per_100g": ("vitamin c (mg)",),
    "vitamin_d_equivalents_ug_per_100g": ("vitamin d3 equivalents (ug)",),
    "vitamin_e_mg_per_100g": ("vitamin e (mg)",),
    "thiamin_mg_per_100g": ("thiamin (b1) (mg)",),
    "riboflavin_mg_per_100g": ("riboflavin (b2) (mg)",),
    "niacin_mg_per_100g": ("niacin (b3) (mg)",),
    "vitamin_b6_mg_per_100g": ("pyridoxine (b6) (mg)",),
    "vitamin_b12_ug_per_100g": ("cobalamin (b12) (ug)",),
    "folate_ug_per_100g": ("total folates (ug)",),
    "folate_dfe_ug_per_100g": ("dietary folate equivalents (ug)",),
}


def fsanz_nutrients(
    header: Sequence[object], row: Sequence[object]
) -> dict[str, float]:
    values = {" ".join(str(h).lower().split()): v for h, v in zip(header, row)}
    fields = {}
    for output, labels in FSANZ_FIELDS.items():
        for label in labels:
            if label in values:
                fields[output] = (label, 1.0)
                break
    result = optional_nutrients(values, fields)
    d2 = measurement(values.get("ergocalciferol (d2) (ug)"))
    d3 = measurement(values.get("cholecalciferol (d3) (ug)"))
    if d2 is not None and d3 is not None:
        result["vitamin_d_ug_per_100g"] = round(d2 + d3, 4)
    return result


OFF_FIELDS = {
    "sugar_per_100g": ("sugars_100g", 1),
    "saturated_fat_per_100g": ("saturated-fat_100g", 1),
    "cholesterol_mg_per_100g": ("cholesterol_100g", 1000),
    "sodium_mg_per_100g": ("sodium_100g", 1000),
    "calcium_mg_per_100g": ("calcium_100g", 1000),
    "iron_mg_per_100g": ("iron_100g", 1000),
    "potassium_mg_per_100g": ("potassium_100g", 1000),
    "magnesium_mg_per_100g": ("magnesium_100g", 1000),
    "phosphorus_mg_per_100g": ("phosphorus_100g", 1000),
    "zinc_mg_per_100g": ("zinc_100g", 1000),
    "selenium_ug_per_100g": ("selenium_100g", 1000000),
    "iodine_ug_per_100g": ("iodine_100g", 1000000),
    "vitamin_c_mg_per_100g": ("vitamin-c_100g", 1000),
    "vitamin_d_ug_per_100g": ("vitamin-d_100g", 1000000),
    "vitamin_e_mg_per_100g": ("vitamin-e_100g", 1000),
    "vitamin_k_ug_per_100g": ("vitamin-k_100g", 1000000),
    "thiamin_mg_per_100g": ("vitamin-b1_100g", 1000),
    "riboflavin_mg_per_100g": ("vitamin-b2_100g", 1000),
    "niacin_mg_per_100g": ("vitamin-pp_100g", 1000),
    "vitamin_b6_mg_per_100g": ("vitamin-b6_100g", 1000),
    "vitamin_b12_ug_per_100g": ("vitamin-b12_100g", 1000000),
    "folate_ug_per_100g": ("vitamin-b9_100g", 1000000),
}


USDA_FIELDS = {
    "sugar_per_100g": ("269", 1),
    "saturated_fat_per_100g": ("606", 1),
    "cholesterol_mg_per_100g": ("601", 1),
    "sodium_mg_per_100g": ("307", 1),
    "calcium_mg_per_100g": ("301", 1),
    "iron_mg_per_100g": ("303", 1),
    "potassium_mg_per_100g": ("306", 1),
    "magnesium_mg_per_100g": ("304", 1),
    "phosphorus_mg_per_100g": ("305", 1),
    "zinc_mg_per_100g": ("309", 1),
    "selenium_ug_per_100g": ("317", 1),
    "iodine_ug_per_100g": ("314", 1),
    "vitamin_a_rae_ug_per_100g": ("320", 1),
    "vitamin_c_mg_per_100g": ("401", 1),
    "vitamin_d_ug_per_100g": ("328", 1),
    "vitamin_e_mg_per_100g": ("323", 1),
    "vitamin_k_ug_per_100g": ("430", 1),
    "thiamin_mg_per_100g": ("404", 1),
    "riboflavin_mg_per_100g": ("405", 1),
    "niacin_mg_per_100g": ("406", 1),
    "vitamin_b6_mg_per_100g": ("415", 1),
    "vitamin_b12_ug_per_100g": ("418", 1),
    "folate_ug_per_100g": ("417", 1),
    "folate_dfe_ug_per_100g": ("435", 1),
}


def reference_food(
    name: str,
    locale: str,
    source: Mapping[str, object],
    fields: Mapping[str, tuple[str, float]],
) -> dict[str, object] | None:
    core = {
        key: measurement(source.get(key))
        for key in ("kcal", "protein", "carbs", "fat", "fiber")
    }
    if not name or any(value is None for value in core.values()):
        return None
    kcal = core["kcal"]
    if kcal is None or kcal > 900:
        return None
    macros = [core[key] for key in ("protein", "carbs", "fat", "fiber")]
    if any(value is None or value > 100 for value in macros):
        return None
    if sum(value for value in macros[:3] if value is not None) > 100:
        return None
    return {
        "name": name,
        "locale": locale,
        **{f"{key}_per_100g": value for key, value in core.items()},
        **optional_nutrients(source, fields),
    }
