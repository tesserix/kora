"""Shared micronutrient output for the *_convert.py scripts.

Keys match nutrition.Micronutrients' JSON tags. A figure the source does not
state is omitted, never written as 0, so LoadFile reads it as unmeasured.
"""

KEYS = (
    "sugar_per_100g",
    "sat_fat_per_100g",
    "sodium_mg_per_100g",
    "cholesterol_mg_per_100g",
    "calcium_mg_per_100g",
    "iron_mg_per_100g",
    "potassium_mg_per_100g",
    "vitamin_a_ug_per_100g",
    "vitamin_c_mg_per_100g",
    "vitamin_d_ug_per_100g",
)


def vitamin_a_rae(retinol, beta_carotene_eq):
    """RAE µg. FSANZ-style tables state retinol equivalents (bce/6); RAE uses bce/12."""
    if retinol is None or beta_carotene_eq is None:
        return None
    return retinol + beta_carotene_eq / 12


def fields(values):
    """Round the measured figures and drop the rest; unknown keys are a bug."""
    unknown = set(values) - set(KEYS)
    if unknown:
        raise ValueError(f"micronutrients: unknown keys {sorted(unknown)}")
    return {k: round(v, 3) for k, v in values.items() if v is not None and v >= 0}


def from_fsanz(get):
    """AFCD and AUSNUT share FSANZ's nutrient set; get(field) returns a figure or None."""
    return fields(
        {
            "sugar_per_100g": get("sugar"),
            "sat_fat_per_100g": get("sat_fat"),
            "sodium_mg_per_100g": get("sodium"),
            "cholesterol_mg_per_100g": get("cholesterol"),
            "calcium_mg_per_100g": get("calcium"),
            "iron_mg_per_100g": get("iron"),
            "potassium_mg_per_100g": get("potassium"),
            "vitamin_a_ug_per_100g": vitamin_a_rae(get("retinol"), get("beta_carotene_eq")),
            "vitamin_c_mg_per_100g": get("vitamin_c"),
            "vitamin_d_ug_per_100g": get("vitamin_d"),
        }
    )
