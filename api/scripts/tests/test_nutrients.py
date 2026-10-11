import csv
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import openpyxl


SCRIPTS = Path(__file__).resolve().parents[1]


def script(name):
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ifct_converts_gram_based_micronutrients_without_inventing_unknowns(tmp_path):
    path = tmp_path / "ifct.csv"
    fields = [
        "name",
        "enerc",
        "protcnt",
        "choavldf",
        "fatce",
        "fibtg",
        "fsugar",
        "fasat",
        "na",
        "vitc",
        "retol",
        "cartbeq",
    ]
    with path.open("w") as out:
        writer = csv.DictWriter(out, fieldnames=fields)
        writer.writeheader()
        writer.writerow(
            dict(
                zip(
                    fields,
                    [
                        "Rice",
                        1500,
                        7,
                        80,
                        1,
                        2,
                        0,
                        0.184,
                        0.00234,
                        0.03028,
                        0,
                        0.002605,
                    ],
                )
            )
        )
    rows, _, _ = script("ifct_convert").convert(path)
    assert rows[0]["sodium_mg_per_100g"] == 2.34
    assert rows[0]["vitamin_c_mg_per_100g"] == 30.28
    assert rows[0]["sugar_per_100g"] == 0
    assert rows[0]["vitamin_a_re_ug_per_100g"] == 434.1667
    assert "vitamin_d_ug_per_100g" not in rows[0]


def test_afcd_uses_saturated_fat_mass_and_preserves_missing_values(tmp_path):
    module = script("afcd_convert")
    w = openpyxl.Workbook()
    s = w.active
    s.title = module.SHEET
    s.append([])
    s.append([])
    header = [None] * 236
    for field, i in module.COL.items():
        header[i] = module.EXPECTED[field]
    header[19] = "Total sugars (g)"
    header[72] = "Sodium (Na) (mg)"
    header[131] = "Total saturated fatty acids, equated (%T)"
    header[191] = "Total saturated fatty acids, equated (g)"
    header[235] = "Cholesterol (mg)"
    s.append(header)
    row = [None] * len(header)
    row[3], row[4], row[7], row[9], row[11], row[39] = "Food", 418.4, 2, 10, 0, 0
    row[19], row[72], row[131], row[191] = 0, 300, 40, 4
    s.append(row)
    path = tmp_path / "afcd.xlsx"
    w.save(path)
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "afcd_convert.py"), str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    food = json.loads(result.stdout)[0]
    assert food["sodium_mg_per_100g"] == 300
    assert food["saturated_fat_per_100g"] == 4
    assert food["sugar_per_100g"] == 0
    assert "cholesterol_mg_per_100g" not in food


def test_fndds_keeps_sodium_and_rae_without_confusing_iu(tmp_path):
    files = {
        "food.csv": "fdc_id,data_type,description\n1,survey_fndds_food,Test meal\n",
        "food_nutrient.csv": "fdc_id,nutrient_id,amount\n1,208,100\n1,203,5\n1,205,15\n1,204,2\n1,291,1\n1,307,420\n1,318,9999\n1,320,12\n1,269,0\n",
        "food_portion.csv": "fdc_id,gram_weight,seq_num,portion_description\n",
    }
    for name, content in files.items():
        (tmp_path / name).write_text(content)
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "fndds_convert.py"), str(tmp_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    food = json.loads(result.stdout)[0]
    assert food["sodium_mg_per_100g"] == 420
    assert food["vitamin_a_rae_ug_per_100g"] == 12
    assert food["sugar_per_100g"] == 0


def test_off_reads_named_headers_and_converts_micronutrient_units(tmp_path):
    header = "code\tproduct_name\tbrands\tcountries_tags\tserving_quantity\tenergy-kcal_100g\tfat_100g\tcarbohydrates_100g\tfiber_100g\tproteins_100g\tsugars_100g\tsaturated-fat_100g\tsodium_100g\tvitamin-d_100g\n"
    product = "4000000000000\tTest snack\tBrand\ten:australia\t30\t100\t2\t15\t1\t5\t0\t1\t0.42\t0.000005\n"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "off_convert.py"),
            "--countries",
            "au",
            "--outdir",
            str(tmp_path),
        ],
        input=header + product,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    food = json.loads((tmp_path / "off_au.json").read_text())[0]
    assert food["locale"] == "AU"
    assert food["sodium_mg_per_100g"] == 420
    assert food["vitamin_d_ug_per_100g"] == 5
    assert food["sugar_per_100g"] == 0


def test_recipe_scales_known_nutrients_and_withholds_partial_measurements():
    module = script("in_dishes_convert")
    rice = {
        "kcal_per_100g": 350,
        "protein_per_100g": 7,
        "carbs_per_100g": 80,
        "fat_per_100g": 1,
        "fiber_per_100g": 2,
        "sodium_mg_per_100g": 4,
        "sugar_per_100g": 0,
    }
    ifct = {"Rice, raw, milled": rice}
    food = module.compute(("Cooked rice", "100 g", 100, [("rice_raw", 100)], 300), ifct)
    assert food["sodium_mg_per_100g"] == 1.3333
    food = module.compute(
        ("Salted rice", "100 g", 100, [("rice_raw", 100), ("salt_spice", 5)], 300), ifct
    )
    assert "sodium_mg_per_100g" not in food
