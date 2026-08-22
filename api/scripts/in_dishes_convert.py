#!/usr/bin/env python3
"""Compute per-100 g nutrition for home-style Indian dishes from IFCT ingredients.

IFCT 2017 measures raw commodities and OpenFoodFacts covers packaged goods, so
neither answers "I ate a bowl of rajma" — the gap aliases.json already warns
about, where `moong dal` resolves to 325 kcal/100 g raw against ~120 cooked.

Every dish here is a recipe: ingredient grams as bought, plus the cooked weight
they yield. Macros come from ifct.json (Indian-measured) or from PANTRY for the
handful of staples IFCT omits, and are divided by the yield. Nothing is typed in
from a nutrition label, so a wrong number is a wrong recipe line rather than an
untraceable guess, and re-running against a newer IFCT re-derives every dish.

Yields carry the cooking: rice and dal absorb water, breads lose it, and deep
frying adds oil (listed as an explicit ingredient rather than modelled).

    python3 scripts/in_dishes_convert.py --outdir data/food
"""

import argparse
import json
import os
import sys

# Staples IFCT 2017 does not carry. Fats and sugar are definitional (oil is
# 100 g fat; sugar is 100 g carbohydrate); the rest are standard whole-food
# values in the same per-100 g edible-portion basis as IFCT.
PANTRY = {
    "oil": (884.0, 0.0, 0.0, 100.0, 0.0),
    "ghee": (900.0, 0.0, 0.0, 100.0, 0.0),
    "butter": (717.0, 0.85, 0.06, 81.1, 0.0),
    "cream": (292.0, 2.8, 3.4, 30.0, 0.0),
    "sugar": (400.0, 0.0, 100.0, 0.0, 0.0),
    "curd": (60.0, 3.1, 4.7, 3.3, 0.0),
    "curd_low_fat": (40.0, 3.5, 4.8, 0.9, 0.0),
    "tofu": (76.0, 8.1, 1.9, 4.8, 0.3),
    "sago": (351.0, 0.2, 87.0, 0.0, 0.9),
    "oats": (389.0, 16.9, 66.3, 6.9, 10.6),
    "honey": (304.0, 0.3, 82.4, 0.0, 0.0),
    "jackfruit_raw": (95.0, 1.7, 23.2, 0.6, 1.5),
    "jowar": (349.0, 10.4, 72.6, 3.1, 9.7),
    "soya_chunks": (345.0, 52.0, 33.0, 0.5, 13.0),
    "bread_white": (265.0, 9.0, 49.0, 3.2, 2.7),
    "noodles_raw": (348.0, 11.0, 71.0, 1.6, 3.0),
    "cornflour": (381.0, 0.3, 91.3, 0.1, 0.9),
    "soy_sauce": (53.0, 8.1, 4.9, 0.6, 0.8),
    "tea_leaf": (0.0, 0.0, 0.0, 0.0, 0.0),
    "coffee_powder": (353.0, 12.2, 41.1, 0.5, 0.0),
    "water": (0.0, 0.0, 0.0, 0.0, 0.0),
    "salt_spice": (0.0, 0.0, 0.0, 0.0, 0.0),
}

# Recipe ingredient key -> IFCT row name. Flours resolve to their grain or dal:
# IFCT lists no besan row, and milling changes nothing but particle size.
IFCT = {
    "rice_raw": "Rice, raw, milled",
    "rice_brown": "Rice, raw, brown",
    "rice_parboiled": "Rice, parboiled, milled",
    "poha_flakes": "Rice flakes",
    "puffed_rice": "Rice puffed",
    "rice_flour": "Rice, raw, milled",
    "atta": "Wheat flour, atta",
    "maida": "Wheat flour, refined",
    "rava": "Wheat, semolina",
    "vermicelli": "Wheat, vermicelli",
    "bulgur": "Wheat, bulgur",
    "barley": "Barley",
    "bajra_flour": "Bajra",
    "ragi_flour": "Ragi",
    "maize_flour": "Maize, dry",
    "toor_dal": "Red gram, dal",
    "moong_dal": "Green gram, dal",
    "moong_whole": "Green gram, whole",
    "urad_dal": "Black gram, dal",
    "chana_dal": "Bengal gram, dal",
    "besan": "Bengal gram, dal",
    "masoor_dal": "Lentil dal",
    "kabuli_chana": "Bengal gram, whole",
    "rajma": "Rajmah, red",
    "lobia": "Cowpea, brown",
    "moth_bean": "Moth bean",
    "horse_gram": "Horse gram, whole",
    "peas_dry": "Peas, dry",
    "peas_fresh": "Peas, fresh",
    "soya_bean": "Soya bean, white",
    "potato": "Potato, brown skin, big",
    "sweet_potato": "Sweet potato, brown skin",
    "onion": "Onion, big",
    "tomato": "Tomato, ripe, local",
    "cauliflower": "Cauliflower",
    "cabbage": "Cabbage, green",
    "carrot": "Carrot, orange",
    "spinach": "Spinach",
    "fenugreek_leaves": "Fenugreek leaves",
    "mustard_leaves": "Mustard leaves",
    "amaranth_leaves": "Amaranth leaves, green",
    "colocasia_leaves": "Colocasia leaves, green",
    "drumstick": "Drumstick",
    "drumstick_leaves": "Drumstick leaves",
    "brinjal": "Brinjal-1",
    "okra": "Ladies finger",
    "bottle_gourd": "Bottle gourd, elongate, pale green",
    "bitter_gourd": "Bitter gourd, jagged, teeth ridges, elongate",
    "snake_gourd": "Snake gourd, long, pale green",
    "pumpkin": "Pumpkin, orange, round",
    "cluster_beans": "Cluster beans",
    "french_beans": "French beans, country",
    "capsicum": "Capsicum, green",
    "cucumber": "Cucumber, green, elongate",
    "radish": "Radish, elongate, white skin",
    "beetroot": "Beet root",
    "yam": "Yam, ordinary",
    "colocasia": "Colocasia, stem, green",
    "plantain_green": "Plantain, green",
    "mushroom": "Button mushroom, fresh",
    "maize_tender": "Maize, tender, sweet",
    "green_chilli": "Chillies, green-1",
    "coriander_leaves": "Coriander leaves",
    "curry_leaves": "Curry leaves",
    "ginger": "Ginger, fresh",
    "garlic": "Garlic, big clove",
    "tamarind": "Tamarind, pulp",
    "coconut_fresh": "Coconut, kernel, fresh",
    "coconut_dry": "Coconut, kernal, dry",
    "cashew": "Cashew nut",
    "almond": "Almond",
    "raisin": "Raisins, dried, black",
    "peanut": "Ground nut",
    "sesame": "Gingelly seeds, white",
    "water_chestnut": "Water Chestnut",
    "egg_white": "Egg, poultry, white, raw",
    "milk": "Milk, whole, Cow",
    "khoa": "Khoa",
    "paneer": "Paneer",
    "egg": "Egg, poultry, whole, raw",
    "chicken_breast": "Chicken, poultry, breast, skinless",
    "chicken_thigh": "Chicken, poultry, thigh, skinless",
    "mutton": "Goat, chops",
    "mutton_lean": "Goat, legs",
    "liver": "Goat, liver",
    "prawns": "Prawns, big",
    "fish": "Cat fish",
    "jaggery": "Jaggery, cane",
    "banana": "Banana, ripe, poovam",
    "mango": "Mango, ripe, banganapalli",
    "pork": "Pork, chops",
    "duck": "Duck, meat, with skin",
    "bamboo_shoot": "Bamboo shoot, tender",
    "ash_gourd": "Ash gourd",
    "tapioca": "Tapioca",
    "ridge_gourd": "Ridge gourd",
    "agathi_leaves": "Agathi leaves",
    "lotus_root": "Lotus root",
    "cumin": "Cumin seeds",
    "coriander_seed": "Coriander seeds",
    "turmeric": "Turmeric powder",
    "mustard_seed": "Mustard seeds",
    "fenugreek_seed": "Fenugreek seeds",
    "poppy_seed": "Poppy seeds",
}

# name, serving description, serving grams, [(ingredient, grams)], cooked yield g
RECIPES = [
    # Rice and khichdi
    ("Rice, white, cooked", "1 cup (150 g)", 150, [("rice_raw", 75)], 195),
    ("Rice, brown, cooked", "1 cup (150 g)", 150, [("rice_brown", 75)], 190),
    ("Curd rice", "1 cup (200 g)", 200, [("rice_raw", 50), ("curd", 100), ("milk", 20), ("oil", 3), ("salt_spice", 2)], 250),
    ("Lemon rice", "1 cup (180 g)", 180, [("rice_raw", 70), ("oil", 8), ("peanut", 8), ("chana_dal", 4), ("curry_leaves", 2)], 200),
    ("Tamarind rice", "1 cup (180 g)", 180, [("rice_raw", 70), ("oil", 10), ("tamarind", 12), ("peanut", 8), ("chana_dal", 5)], 205),
    ("Coconut rice", "1 cup (180 g)", 180, [("rice_raw", 70), ("coconut_fresh", 25), ("oil", 8), ("urad_dal", 4)], 200),
    ("Vegetable pulao", "1 cup (180 g)", 180, [("rice_raw", 65), ("carrot", 20), ("peas_fresh", 20), ("potato", 20), ("onion", 20), ("oil", 8)], 215),
    ("Ghee rice", "1 cup (180 g)", 180, [("rice_raw", 70), ("ghee", 10), ("onion", 15), ("cashew", 5)], 200),
    ("Bisi bele bath", "1 cup (200 g)", 200, [("rice_raw", 45), ("toor_dal", 20), ("carrot", 20), ("peas_fresh", 15), ("oil", 8), ("tamarind", 5)], 240),
    ("Curd rice, low fat", "1 cup (200 g)", 200, [("rice_raw", 50), ("curd_low_fat", 110), ("salt_spice", 2)], 250),
    ("Mutton biryani", "1 plate (250 g)", 250, [("rice_raw", 80), ("mutton", 70), ("oil", 12), ("curd", 25), ("onion", 30)], 285),
    ("Egg biryani", "1 plate (250 g)", 250, [("rice_raw", 80), ("egg", 55), ("oil", 10), ("curd", 20), ("onion", 25)], 275),
    ("Prawn biryani", "1 plate (250 g)", 250, [("rice_raw", 80), ("prawns", 60), ("oil", 10), ("curd", 20), ("onion", 25)], 275),
    ("Fried rice, Indo-Chinese", "1 cup (180 g)", 180, [("rice_raw", 65), ("cabbage", 25), ("carrot", 20), ("capsicum", 15), ("oil", 10), ("soy_sauce", 5)], 210),
    ("Millet khichdi, foxtail", "1 cup (200 g)", 200, [("jowar", 45), ("moong_dal", 25), ("oil", 6), ("carrot", 20)], 245),
    ("Bajra khichdi", "1 cup (200 g)", 200, [("bajra_flour", 45), ("moong_dal", 25), ("ghee", 6)], 245),
    ("Dalia, savoury", "1 cup (200 g)", 200, [("bulgur", 50), ("carrot", 20), ("peas_fresh", 15), ("oil", 6)], 240),
    ("Quinoa pulao", "1 cup (180 g)", 180, [("bulgur", 55), ("carrot", 20), ("peas_fresh", 20), ("oil", 7)], 210),

    # Dals and legumes
    ("Dal fry", "1 cup (150 g)", 150, [("toor_dal", 35), ("onion", 20), ("tomato", 20), ("oil", 7)], 165),
    ("Toor dal, plain", "1 cup (150 g)", 150, [("toor_dal", 35), ("turmeric", 1), ("oil", 3)], 160),
    ("Moong dal, cooked", "1 cup (150 g)", 150, [("moong_dal", 35), ("oil", 3), ("turmeric", 1)], 160),
    ("Masoor dal, cooked", "1 cup (150 g)", 150, [("masoor_dal", 35), ("oil", 4), ("onion", 10)], 160),
    ("Chana dal, cooked", "1 cup (150 g)", 150, [("chana_dal", 35), ("oil", 5), ("onion", 10)], 160),
    ("Dal palak", "1 cup (150 g)", 150, [("moong_dal", 25), ("spinach", 45), ("oil", 6), ("garlic", 3)], 165),
    ("Kadhi, Punjabi", "1 cup (180 g)", 180, [("curd", 70), ("besan", 15), ("oil", 8), ("onion", 10)], 200),
    ("Kadhi, Gujarati", "1 cup (180 g)", 180, [("curd", 75), ("besan", 10), ("jaggery", 6), ("oil", 5)], 205),
    ("Chole, Punjabi", "1 cup (150 g)", 150, [("kabuli_chana", 45), ("onion", 25), ("tomato", 25), ("oil", 10)], 170),
    ("Lobia curry", "1 cup (150 g)", 150, [("lobia", 45), ("onion", 20), ("tomato", 20), ("oil", 8)], 170),
    ("Moth bean curry", "1 cup (150 g)", 150, [("moth_bean", 45), ("onion", 20), ("tomato", 15), ("oil", 8)], 170),
    ("Horse gram curry", "1 cup (150 g)", 150, [("horse_gram", 45), ("onion", 15), ("tamarind", 5), ("oil", 8)], 170),
    ("Ghugni, yellow peas", "1 cup (150 g)", 150, [("peas_dry", 45), ("onion", 20), ("oil", 8), ("tomato", 15)], 170),
    ("Chholar dal", "1 cup (150 g)", 150, [("chana_dal", 35), ("coconut_fresh", 8), ("ghee", 6), ("raisin", 4)], 160),
    ("Sprouted moong salad", "1 cup (100 g)", 100, [("moong_whole", 40), ("onion", 20), ("tomato", 20), ("coriander_leaves", 5)], 110),
    ("Sprouted moong chaat", "1 cup (120 g)", 120, [("moong_whole", 40), ("onion", 20), ("tomato", 20), ("potato", 20), ("oil", 3)], 130),
    ("Soya chunks curry", "1 cup (150 g)", 150, [("soya_chunks", 25), ("onion", 25), ("tomato", 25), ("oil", 9)], 170),
    ("Soya keema", "1 cup (150 g)", 150, [("soya_chunks", 30), ("onion", 30), ("tomato", 20), ("oil", 10)], 165),
    ("Dal dhokli", "1 cup (200 g)", 200, [("toor_dal", 30), ("atta", 25), ("oil", 8), ("jaggery", 4)], 225),
    ("Pitla", "1 cup (150 g)", 150, [("besan", 30), ("onion", 20), ("oil", 8), ("green_chilli", 3)], 165),
    ("Sambar, drumstick", "1 cup (180 g)", 180, [("toor_dal", 25), ("drumstick", 40), ("tamarind", 6), ("oil", 6)], 200),

    # Breads
    ("Phulka", "1 piece (35 g)", 35, [("atta", 30)], 35),
    ("Bhakri, jowar", "1 piece (55 g)", 55, [("jowar", 45)], 55),
    ("Bajra roti", "1 piece (55 g)", 55, [("bajra_flour", 45)], 55),
    ("Ragi roti", "1 piece (55 g)", 55, [("ragi_flour", 45)], 55),
    ("Makki di roti", "1 piece (60 g)", 60, [("maize_flour", 45), ("oil", 4)], 60),
    ("Missi roti", "1 piece (55 g)", 55, [("atta", 25), ("besan", 18), ("oil", 4)], 55),
    ("Multigrain roti", "1 piece (40 g)", 40, [("atta", 20), ("bajra_flour", 8), ("ragi_flour", 8), ("besan", 4)], 40),
    ("Thepla, methi", "1 piece (40 g)", 40, [("atta", 25), ("fenugreek_leaves", 12), ("oil", 5)], 40),
    ("Kulcha, plain", "1 piece (70 g)", 70, [("maida", 50), ("curd", 12), ("oil", 5)], 70),
    ("Bhatura", "1 piece (70 g)", 70, [("maida", 45), ("curd", 10), ("oil", 12)], 70),
    ("Paratha, gobi", "1 piece (90 g)", 90, [("atta", 40), ("cauliflower", 40), ("oil", 8)], 90),
    ("Paratha, paneer", "1 piece (90 g)", 90, [("atta", 40), ("paneer", 35), ("oil", 8)], 90),
    ("Paratha, methi", "1 piece (80 g)", 80, [("atta", 40), ("fenugreek_leaves", 25), ("oil", 8)], 80),
    ("Paratha, mooli", "1 piece (90 g)", 90, [("atta", 40), ("radish", 40), ("oil", 8)], 90),
    ("Luchi", "1 piece (30 g)", 30, [("maida", 20), ("oil", 7)], 30),
    ("Appam", "1 piece (60 g)", 60, [("rice_raw", 25), ("coconut_fresh", 10)], 60),
    ("Neer dosa", "1 piece (50 g)", 50, [("rice_raw", 20), ("coconut_fresh", 6)], 50),
    ("Rava dosa", "1 piece (75 g)", 75, [("rava", 22), ("rice_flour", 12), ("oil", 8)], 75),
    ("Uttapam, onion", "1 piece (110 g)", 110, [("rice_raw", 35), ("urad_dal", 12), ("onion", 30), ("oil", 6)], 110),
    ("Set dosa", "1 piece (60 g)", 60, [("rice_raw", 22), ("urad_dal", 8), ("oil", 4)], 60),
    ("Rumali roti", "1 piece (45 g)", 45, [("maida", 35), ("oil", 2)], 45),
    ("Puttu", "1 cup (120 g)", 120, [("rice_flour", 55), ("coconut_fresh", 20)], 120),
    ("Idiyappam", "1 piece (60 g)", 60, [("rice_flour", 28), ("coconut_fresh", 6)], 60),

    # South Indian tiffin
    ("Rava idli", "1 piece (55 g)", 55, [("rava", 22), ("curd", 12), ("oil", 3), ("cashew", 2)], 55),
    ("Rava upma", "1 cup (180 g)", 180, [("rava", 55), ("oil", 10), ("onion", 20), ("urad_dal", 4)], 205),
    ("Ven pongal", "1 cup (180 g)", 180, [("rice_raw", 45), ("moong_dal", 20), ("ghee", 12), ("cashew", 5)], 205),
    ("Sweet pongal", "1 cup (180 g)", 180, [("rice_raw", 45), ("moong_dal", 12), ("jaggery", 40), ("ghee", 12), ("cashew", 5)], 205),
    ("Dahi vada", "2 pieces (120 g)", 120, [("urad_dal", 30), ("curd", 70), ("oil", 10)], 135),
    ("Sambar rice", "1 cup (200 g)", 200, [("rice_raw", 45), ("toor_dal", 20), ("tamarind", 5), ("oil", 7), ("drumstick", 20)], 240),
    ("Rasam rice", "1 cup (200 g)", 200, [("rice_raw", 50), ("toor_dal", 10), ("tamarind", 6), ("oil", 5)], 240),
    ("Upma, vermicelli", "1 cup (180 g)", 180, [("vermicelli", 50), ("oil", 10), ("onion", 20), ("carrot", 15)], 205),
    ("Kesari bath", "1 cup (150 g)", 150, [("rava", 45), ("sugar", 40), ("ghee", 15), ("cashew", 5)], 175),
    ("Akki roti", "1 piece (70 g)", 70, [("rice_flour", 40), ("onion", 15), ("oil", 5)], 70),
    ("Kadala curry", "1 cup (150 g)", 150, [("kabuli_chana", 40), ("coconut_fresh", 20), ("onion", 20), ("oil", 8)], 170),
    ("Avial", "1 cup (150 g)", 150, [("bottle_gourd", 35), ("carrot", 25), ("drumstick", 25), ("coconut_fresh", 25), ("curd", 20), ("oil", 6)], 165),
    ("Thoran, cabbage", "1 cup (120 g)", 120, [("cabbage", 90), ("coconut_fresh", 20), ("oil", 6)], 125),
    ("Poriyal, beans", "1 cup (120 g)", 120, [("french_beans", 90), ("coconut_fresh", 15), ("oil", 6)], 125),
    ("Olan", "1 cup (150 g)", 150, [("pumpkin", 80), ("lobia", 15), ("coconut_fresh", 25), ("oil", 5)], 160),
    ("Kootu, bottle gourd", "1 cup (150 g)", 150, [("bottle_gourd", 80), ("moong_dal", 20), ("coconut_fresh", 15), ("oil", 5)], 165),
    ("Stew, vegetable, Kerala", "1 cup (180 g)", 180, [("potato", 50), ("carrot", 30), ("peas_fresh", 15), ("coconut_fresh", 30), ("oil", 6)], 200),

    # Vegetable curries
    ("Matar paneer", "1 cup (150 g)", 150, [("paneer", 45), ("peas_fresh", 35), ("tomato", 30), ("onion", 20), ("oil", 10)], 165),
    ("Kadai paneer", "1 cup (150 g)", 150, [("paneer", 50), ("capsicum", 30), ("tomato", 30), ("onion", 20), ("oil", 11)], 165),
    ("Shahi paneer", "1 cup (150 g)", 150, [("paneer", 50), ("cream", 20), ("cashew", 10), ("tomato", 25), ("oil", 10)], 165),
    ("Malai kofta", "1 cup (150 g)", 150, [("paneer", 35), ("potato", 30), ("cream", 20), ("cashew", 10), ("oil", 15)], 165),
    ("Paneer bhurji", "1 cup (130 g)", 130, [("paneer", 60), ("onion", 25), ("tomato", 25), ("oil", 9)], 140),
    ("Dum aloo", "1 cup (150 g)", 150, [("potato", 90), ("curd", 25), ("tomato", 20), ("oil", 12)], 160),
    ("Jeera aloo", "1 cup (130 g)", 130, [("potato", 110), ("oil", 9), ("cumin", 2)], 135),
    ("Aloo matar", "1 cup (150 g)", 150, [("potato", 70), ("peas_fresh", 35), ("tomato", 25), ("oil", 9)], 165),
    ("Aloo baingan", "1 cup (150 g)", 150, [("potato", 60), ("brinjal", 60), ("tomato", 20), ("oil", 10)], 160),
    ("Mixed vegetable curry", "1 cup (150 g)", 150, [("carrot", 35), ("peas_fresh", 25), ("cauliflower", 35), ("potato", 30), ("oil", 9)], 165),
    ("Navratan korma", "1 cup (150 g)", 150, [("carrot", 25), ("peas_fresh", 20), ("paneer", 20), ("cream", 15), ("cashew", 10), ("oil", 10)], 165),
    ("Sarson da saag", "1 cup (150 g)", 150, [("mustard_leaves", 90), ("spinach", 40), ("maize_flour", 10), ("ghee", 10)], 155),
    ("Palak, dry", "1 cup (120 g)", 120, [("spinach", 130), ("oil", 7), ("garlic", 4)], 125),
    ("Methi aloo", "1 cup (140 g)", 140, [("fenugreek_leaves", 60), ("potato", 70), ("oil", 9)], 145),
    ("Lauki sabzi", "1 cup (150 g)", 150, [("bottle_gourd", 140), ("tomato", 20), ("oil", 8)], 155),
    ("Tinda masala", "1 cup (150 g)", 150, [("bottle_gourd", 130), ("onion", 20), ("oil", 9)], 155),
    ("Karela sabzi", "1 cup (120 g)", 120, [("bitter_gourd", 110), ("onion", 20), ("oil", 10)], 125),
    ("Turai sabzi", "1 cup (150 g)", 150, [("snake_gourd", 140), ("onion", 15), ("oil", 8)], 155),
    ("Kaddu sabzi", "1 cup (150 g)", 150, [("pumpkin", 140), ("oil", 8), ("jaggery", 5)], 155),
    ("Gobi matar", "1 cup (150 g)", 150, [("cauliflower", 100), ("peas_fresh", 30), ("oil", 9)], 155),
    ("Cabbage sabzi", "1 cup (130 g)", 130, [("cabbage", 130), ("peas_fresh", 15), ("oil", 8)], 135),
    ("Beans poriyal", "1 cup (120 g)", 120, [("french_beans", 100), ("coconut_fresh", 12), ("oil", 6)], 125),
    ("Bharwa bhindi", "1 cup (130 g)", 130, [("okra", 110), ("besan", 12), ("oil", 12)], 135),
    ("Mushroom masala", "1 cup (150 g)", 150, [("mushroom", 110), ("onion", 25), ("tomato", 25), ("oil", 10)], 160),
    ("Veg kolhapuri", "1 cup (150 g)", 150, [("cauliflower", 40), ("carrot", 30), ("peas_fresh", 20), ("coconut_dry", 12), ("oil", 12)], 165),
    ("Undhiyu", "1 cup (150 g)", 150, [("yam", 35), ("plantain_green", 30), ("peas_fresh", 25), ("potato", 30), ("coconut_fresh", 15), ("oil", 12)], 160),
    ("Aloo posto", "1 cup (140 g)", 140, [("potato", 110), ("poppy_seed", 15), ("oil", 10)], 145),
    ("Shukto", "1 cup (150 g)", 150, [("bitter_gourd", 40), ("bottle_gourd", 50), ("plantain_green", 30), ("milk", 20), ("oil", 8)], 160),
    ("Chokha, baingan", "1 cup (130 g)", 130, [("brinjal", 130), ("onion", 20), ("oil", 7)], 135),
    ("Jackfruit curry", "1 cup (150 g)", 150, [("jackfruit_raw", 110), ("onion", 20), ("tomato", 20), ("oil", 10)], 160),
    ("Yam curry", "1 cup (150 g)", 150, [("yam", 110), ("onion", 20), ("tamarind", 5), ("oil", 9)], 160),
    ("Kathal masala", "1 cup (150 g)", 150, [("jackfruit_raw", 100), ("onion", 25), ("curd", 20), ("oil", 12)], 160),
    ("Tofu bhurji", "1 cup (130 g)", 130, [("tofu", 90), ("onion", 25), ("tomato", 25), ("oil", 8)], 140),
    ("Chana saag", "1 cup (150 g)", 150, [("kabuli_chana", 35), ("spinach", 70), ("oil", 8)], 165),

    # Meat, fish and egg
    ("Mutton curry, home-style", "1 cup (150 g)", 150, [("mutton", 90), ("onion", 30), ("tomato", 25), ("oil", 12)], 160),
    ("Rogan josh", "1 cup (150 g)", 150, [("mutton", 90), ("curd", 30), ("onion", 25), ("oil", 14)], 160),
    ("Mutton keema", "1 cup (150 g)", 150, [("mutton_lean", 95), ("onion", 30), ("peas_fresh", 15), ("oil", 12)], 155),
    ("Chicken chettinad", "1 cup (150 g)", 150, [("chicken_thigh", 95), ("coconut_dry", 15), ("onion", 25), ("oil", 12)], 160),
    ("Chicken 65", "1 cup (120 g)", 120, [("chicken_breast", 95), ("besan", 12), ("curd", 15), ("oil", 14)], 125),
    ("Chicken kebab, seekh", "2 pieces (100 g)", 100, [("chicken_breast", 90), ("onion", 15), ("besan", 6), ("oil", 8)], 100),
    ("Grilled chicken breast, masala", "1 piece (115 g)", 115, [("chicken_breast", 140), ("curd", 20), ("oil", 3)], 115),
    ("Chicken soup, clear", "1 cup (200 g)", 200, [("chicken_breast", 30), ("carrot", 15), ("cornflour", 5), ("oil", 3)], 210),
    ("Fish curry, Kerala", "1 cup (150 g)", 150, [("fish", 90), ("coconut_fresh", 25), ("tamarind", 6), ("oil", 10)], 160),
    ("Fish curry, Bengali", "1 cup (150 g)", 150, [("fish", 95), ("onion", 20), ("tomato", 20), ("oil", 12)], 160),
    ("Fish fry, shallow", "1 piece (100 g)", 100, [("fish", 100), ("rice_flour", 8), ("oil", 10)], 100),
    ("Prawn curry", "1 cup (150 g)", 150, [("prawns", 85), ("coconut_fresh", 20), ("onion", 20), ("oil", 10)], 160),
    ("Prawn masala, dry", "1 cup (120 g)", 120, [("prawns", 95), ("onion", 25), ("oil", 10)], 125),
    ("Egg bhurji", "1 cup (120 g)", 120, [("egg", 100), ("onion", 25), ("tomato", 20), ("oil", 8)], 125),
    ("Egg, boiled", "1 egg (50 g)", 50, [("egg", 50)], 50),
    ("Omelette, masala", "1 omelette (90 g)", 90, [("egg", 100), ("onion", 15), ("oil", 6)], 95),
    ("Egg white omelette", "1 omelette (90 g)", 90, [("egg_white", 100), ("onion", 10), ("oil", 3)], 95),
    ("Liver fry", "1 cup (120 g)", 120, [("liver", 95), ("onion", 25), ("oil", 10)], 125),
    ("Chicken tikka, dry", "4 pieces (120 g)", 120, [("chicken_breast", 120), ("curd", 25), ("oil", 8)], 125),

    # Street food and chaat
    ("Chole bhature", "1 plate (250 g)", 250, [("kabuli_chana", 55), ("onion", 25), ("maida", 60), ("oil", 30)], 270),
    ("Aloo tikki", "2 pieces (110 g)", 110, [("potato", 100), ("besan", 10), ("oil", 12)], 115),
    ("Ragda pattice", "1 plate (200 g)", 200, [("peas_dry", 40), ("potato", 80), ("oil", 14)], 225),
    ("Misal pav", "1 plate (250 g)", 250, [("moth_bean", 45), ("onion", 25), ("oil", 15), ("bread_white", 60)], 270),
    ("Bhel puri", "1 plate (120 g)", 120, [("puffed_rice", 35), ("potato", 30), ("onion", 20), ("besan", 10), ("oil", 8)], 125),
    ("Sev puri", "1 plate (120 g)", 120, [("maida", 25), ("potato", 35), ("besan", 15), ("oil", 14)], 125),
    ("Pani puri", "6 pieces (120 g)", 120, [("rava", 25), ("potato", 30), ("kabuli_chana", 15), ("oil", 10)], 130),
    ("Dahi puri", "6 pieces (150 g)", 150, [("rava", 25), ("potato", 30), ("curd", 50), ("besan", 10), ("oil", 10)], 155),
    ("Papdi chaat", "1 plate (150 g)", 150, [("maida", 30), ("potato", 35), ("curd", 45), ("oil", 14)], 155),
    ("Dahi bhalla", "2 pieces (130 g)", 130, [("urad_dal", 30), ("curd", 70), ("oil", 12)], 140),
    ("Vada pav", "1 piece (140 g)", 140, [("potato", 65), ("besan", 20), ("bread_white", 50), ("oil", 16)], 145),
    ("Dabeli", "1 piece (130 g)", 130, [("potato", 55), ("bread_white", 50), ("peanut", 10), ("oil", 12)], 135),
    ("Kachori, dal", "1 piece (60 g)", 60, [("maida", 30), ("moong_dal", 12), ("oil", 14)], 60),
    ("Onion pakora", "6 pieces (80 g)", 80, [("onion", 55), ("besan", 30), ("oil", 16)], 85),
    ("Paneer pakora", "3 pieces (90 g)", 90, [("paneer", 50), ("besan", 25), ("oil", 16)], 90),
    ("Bread pakora", "1 piece (90 g)", 90, [("bread_white", 40), ("potato", 30), ("besan", 15), ("oil", 16)], 90),
    ("Batata vada", "2 pieces (90 g)", 90, [("potato", 55), ("besan", 22), ("oil", 15)], 90),
    ("Sabudana vada", "2 pieces (90 g)", 90, [("sago", 40), ("potato", 30), ("peanut", 12), ("oil", 15)], 90),
    ("Kathi roll, veg", "1 roll (180 g)", 180, [("maida", 55), ("paneer", 40), ("onion", 25), ("capsicum", 20), ("oil", 16)], 185),
    ("Kathi roll, chicken", "1 roll (180 g)", 180, [("maida", 55), ("chicken_breast", 55), ("onion", 25), ("oil", 16)], 185),
    ("Momo, veg, steamed", "6 pieces (150 g)", 150, [("maida", 55), ("cabbage", 55), ("carrot", 25), ("oil", 6)], 155),
    ("Momo, chicken, steamed", "6 pieces (150 g)", 150, [("maida", 55), ("chicken_breast", 55), ("cabbage", 25), ("oil", 6)], 155),
    ("Spring roll, veg", "2 pieces (110 g)", 110, [("maida", 35), ("cabbage", 35), ("carrot", 20), ("oil", 18)], 110),
    ("Litti chokha", "1 plate (200 g)", 200, [("atta", 60), ("besan", 30), ("brinjal", 60), ("oil", 16)], 210),

    # Indo-Chinese
    ("Gobi manchurian", "1 cup (150 g)", 150, [("cauliflower", 100), ("maida", 20), ("cornflour", 10), ("oil", 20), ("soy_sauce", 6)], 155),
    ("Chilli paneer", "1 cup (150 g)", 150, [("paneer", 80), ("capsicum", 30), ("onion", 20), ("cornflour", 8), ("oil", 16)], 155),
    ("Chilli chicken", "1 cup (150 g)", 150, [("chicken_breast", 90), ("capsicum", 25), ("onion", 20), ("cornflour", 8), ("oil", 16)], 155),
    ("Hakka noodles, veg", "1 cup (180 g)", 180, [("noodles_raw", 55), ("cabbage", 30), ("carrot", 25), ("oil", 12), ("soy_sauce", 6)], 200),
    ("Manchow soup", "1 cup (200 g)", 200, [("cabbage", 25), ("carrot", 15), ("cornflour", 8), ("oil", 6), ("soy_sauce", 5)], 210),
    ("Schezwan fried rice", "1 cup (180 g)", 180, [("rice_raw", 65), ("cabbage", 25), ("capsicum", 20), ("oil", 12), ("soy_sauce", 6)], 210),

    # Snacks
    ("Dhokla", "2 pieces (100 g)", 100, [("besan", 40), ("curd", 25), ("oil", 6), ("sugar", 5)], 110),
    ("Khandvi", "4 pieces (100 g)", 100, [("besan", 25), ("curd", 45), ("oil", 6), ("coconut_fresh", 5)], 105),
    ("Handvo", "1 piece (100 g)", 100, [("rice_raw", 25), ("chana_dal", 15), ("bottle_gourd", 35), ("oil", 10)], 105),
    ("Muthiya, steamed", "3 pieces (100 g)", 100, [("atta", 30), ("besan", 15), ("bottle_gourd", 40), ("oil", 8)], 105),
    ("Khakhra", "2 pieces (30 g)", 30, [("atta", 25), ("oil", 4)], 30),
    ("Mathri", "3 pieces (45 g)", 45, [("maida", 28), ("oil", 14)], 45),
    ("Murukku", "3 pieces (45 g)", 45, [("rice_flour", 28), ("urad_dal", 6), ("oil", 13)], 45),
    ("Chakli", "3 pieces (45 g)", 45, [("rice_flour", 25), ("besan", 8), ("oil", 13)], 45),
    ("Namkeen mixture", "1 handful (30 g)", 30, [("besan", 14), ("puffed_rice", 6), ("peanut", 5), ("oil", 8)], 30),
    ("Bhujia sev", "1 handful (30 g)", 30, [("besan", 20), ("oil", 10)], 30),
    ("Banana chips", "1 handful (30 g)", 30, [("plantain_green", 30), ("oil", 9)], 30),
    ("Roasted chana", "1 handful (30 g)", 30, [("kabuli_chana", 30)], 30),
    ("Makhana, roasted", "1 cup (25 g)", 25, [("puffed_rice", 22), ("ghee", 3)], 25),
    ("Peanut chikki", "1 piece (30 g)", 30, [("peanut", 16), ("jaggery", 16)], 30),
    ("Sabudana khichdi", "1 cup (180 g)", 180, [("sago", 55), ("potato", 40), ("peanut", 20), ("oil", 10)], 195),
    ("Poha, kanda", "1 cup (170 g)", 170, [("poha_flakes", 50), ("onion", 30), ("potato", 25), ("oil", 9)], 190),
    ("Oats upma", "1 cup (180 g)", 180, [("oats", 45), ("carrot", 20), ("peas_fresh", 15), ("oil", 7)], 205),
    ("Oats porridge, milk", "1 cup (200 g)", 200, [("oats", 40), ("milk", 150), ("sugar", 8)], 215),
    ("Ragi malt", "1 glass (200 g)", 200, [("ragi_flour", 30), ("milk", 100), ("jaggery", 15)], 215),
    ("Ragi mudde", "1 piece (120 g)", 120, [("ragi_flour", 45)], 125),
    ("Besan chilla", "2 pieces (110 g)", 110, [("besan", 45), ("onion", 25), ("oil", 8)], 115),
    ("Moong dal chilla", "2 pieces (110 g)", 110, [("moong_dal", 45), ("onion", 20), ("oil", 8)], 115),
    ("Paneer tikka, dry", "4 pieces (120 g)", 120, [("paneer", 100), ("curd", 20), ("capsicum", 15), ("oil", 7)], 125),
    ("Corn chaat", "1 cup (130 g)", 130, [("maize_tender", 110), ("onion", 15), ("butter", 6)], 135),
    ("Fruit chaat", "1 cup (150 g)", 150, [("banana", 60), ("mango", 60), ("sugar", 5)], 155),

    # Sweets
    ("Rasgulla", "2 pieces (100 g)", 100, [("paneer", 40), ("sugar", 35)], 105),
    ("Rasmalai", "2 pieces (120 g)", 120, [("paneer", 40), ("milk", 60), ("sugar", 25), ("cashew", 4)], 125),
    ("Sandesh", "2 pieces (60 g)", 60, [("paneer", 45), ("sugar", 18)], 62),
    ("Mishti doi", "1 cup (120 g)", 120, [("milk", 100), ("sugar", 25), ("curd", 10)], 125),
    ("Besan ladoo", "1 piece (40 g)", 40, [("besan", 20), ("sugar", 12), ("ghee", 9)], 40),
    ("Motichoor ladoo", "1 piece (40 g)", 40, [("besan", 18), ("sugar", 15), ("ghee", 8)], 40),
    ("Rava ladoo", "1 piece (40 g)", 40, [("rava", 18), ("sugar", 13), ("ghee", 8), ("coconut_dry", 3)], 40),
    ("Kaju barfi", "2 pieces (40 g)", 40, [("cashew", 22), ("sugar", 16), ("ghee", 3)], 40),
    ("Besan barfi", "2 pieces (40 g)", 40, [("besan", 18), ("sugar", 14), ("ghee", 7)], 40),
    ("Milk peda", "2 pieces (40 g)", 40, [("khoa", 25), ("sugar", 14)], 40),
    ("Gajar halwa", "1 cup (150 g)", 150, [("carrot", 120), ("milk", 60), ("sugar", 30), ("ghee", 12), ("cashew", 5)], 160),
    ("Sooji halwa", "1 cup (150 g)", 150, [("rava", 45), ("sugar", 40), ("ghee", 25)], 160),
    ("Moong dal halwa", "1 cup (150 g)", 150, [("moong_dal", 45), ("sugar", 40), ("ghee", 30)], 160),
    ("Mysore pak", "2 pieces (40 g)", 40, [("besan", 14), ("sugar", 16), ("ghee", 12)], 40),
    ("Soan papdi", "2 pieces (40 g)", 40, [("besan", 12), ("maida", 6), ("sugar", 16), ("ghee", 7)], 40),
    ("Malpua", "2 pieces (80 g)", 80, [("maida", 25), ("milk", 25), ("sugar", 20), ("oil", 12)], 82),
    ("Payasam, semiya", "1 cup (180 g)", 180, [("vermicelli", 25), ("milk", 130), ("sugar", 25), ("ghee", 6), ("cashew", 5)], 195),
    ("Shrikhand", "1 cup (120 g)", 120, [("curd", 90), ("sugar", 30), ("cashew", 5)], 125),
    ("Basundi", "1 cup (150 g)", 150, [("milk", 200), ("sugar", 25), ("cashew", 5)], 160),
    ("Kulfi", "1 piece (80 g)", 80, [("milk", 110), ("sugar", 18), ("cashew", 5)], 85),
    ("Puran poli", "1 piece (80 g)", 80, [("atta", 30), ("chana_dal", 25), ("jaggery", 22), ("ghee", 8)], 82),
    ("Modak, steamed", "2 pieces (80 g)", 80, [("rice_flour", 30), ("coconut_fresh", 30), ("jaggery", 18)], 82),
    ("Chhena poda", "1 piece (80 g)", 80, [("paneer", 50), ("sugar", 22), ("rava", 6)], 82),
    ("Coconut barfi", "2 pieces (40 g)", 40, [("coconut_fresh", 25), ("sugar", 15), ("ghee", 3)], 40),

    # Beverages
    ("Filter coffee, with milk and sugar", "1 cup (150 g)", 150, [("milk", 100), ("coffee_powder", 5), ("sugar", 8), ("water", 50)], 155),
    ("Tea, black, with sugar", "1 cup (150 g)", 150, [("sugar", 8), ("water", 145)], 150),
    ("Buttermilk, salted", "1 glass (200 g)", 200, [("curd", 70), ("water", 135)], 205),
    ("Lassi, salted", "1 glass (200 g)", 200, [("curd", 130), ("water", 70)], 200),
    ("Nimbu pani, sweet", "1 glass (200 g)", 200, [("sugar", 18), ("water", 185)], 200),
    ("Jaljeera", "1 glass (200 g)", 200, [("sugar", 10), ("tamarind", 5), ("water", 190)], 200),
    ("Aam panna", "1 glass (200 g)", 200, [("mango", 45), ("sugar", 18), ("water", 145)], 205),
    ("Badam milk", "1 glass (200 g)", 200, [("milk", 170), ("almond", 12), ("sugar", 16)], 200),
    ("Thandai", "1 glass (200 g)", 200, [("milk", 160), ("almond", 10), ("cashew", 6), ("sugar", 18)], 200),
    ("Sattu drink", "1 glass (200 g)", 200, [("kabuli_chana", 30), ("sugar", 10), ("water", 165)], 205),
    ("Sugarcane juice", "1 glass (200 g)", 200, [("sugar", 24), ("water", 180)], 205),
    ("Coconut water", "1 glass (200 g)", 200, [("water", 200), ("sugar", 5)], 205),

    # Fasting foods
    ("Kuttu puri", "2 pieces (70 g)", 70, [("bajra_flour", 40), ("potato", 20), ("oil", 14)], 70),
    ("Singhara halwa", "1 cup (150 g)", 150, [("water_chestnut", 40), ("sugar", 35), ("ghee", 22)], 160),
    ("Rajgira ladoo", "1 piece (35 g)", 35, [("puffed_rice", 16), ("jaggery", 16)], 35),
    ("Vrat ke chawal", "1 cup (180 g)", 180, [("rice_raw", 60), ("peanut", 12), ("ghee", 8)], 200),

    # State signatures. Grouped by state so coverage is auditable per state
    # rather than by whichever dishes happen to be famous nationally; the
    # sections above are the pan-Indian everyday set.

    # Andhra Pradesh
    ("Pesarattu", "1 piece (110 g)", 110, [("moong_whole", 60), ("rice_raw", 10), ("green_chilli", 5), ("oil", 6)], 110),
    ("Gongura pachadi", "2 tbsp (40 g)", 40, [("amaranth_leaves", 70), ("oil", 12), ("green_chilli", 5), ("tamarind", 5)], 90),
    ("Gutti vankaya", "1 cup (140 g)", 140, [("brinjal", 110), ("peanut", 15), ("coconut_dry", 8), ("oil", 12)], 140),
    ("Ulava charu", "1 cup (180 g)", 180, [("horse_gram", 40), ("tamarind", 6), ("oil", 6)], 190),
    ("Punugulu", "4 pieces (60 g)", 60, [("rice_raw", 30), ("urad_dal", 10), ("oil", 14)], 60),

    # Arunachal Pradesh
    ("Bamboo shoot curry", "1 cup (130 g)", 130, [("bamboo_shoot", 100), ("onion", 15), ("oil", 8)], 130),
    ("Thukpa, chicken", "1 bowl (250 g)", 250, [("noodles_raw", 45), ("chicken_breast", 40), ("cabbage", 25), ("carrot", 15), ("oil", 8)], 250),

    # Assam
    ("Masor tenga", "1 cup (165 g)", 165, [("fish", 100), ("tomato", 40), ("oil", 10)], 165),
    ("Aloo pitika", "1 cup (135 g)", 135, [("potato", 120), ("onion", 12), ("oil", 6)], 135),
    ("Khar, raw plantain", "1 cup (130 g)", 130, [("plantain_green", 100), ("oil", 6), ("onion", 12)], 130),
    ("Til pitha", "1 piece (65 g)", 65, [("rice_flour", 40), ("sesame", 15), ("jaggery", 15)], 65),

    # Bihar
    ("Sattu paratha", "1 piece (95 g)", 95, [("atta", 45), ("kabuli_chana", 25), ("oil", 8)], 95),
    ("Dal pitha", "2 pieces (80 g)", 80, [("rice_flour", 40), ("chana_dal", 15), ("oil", 3)], 80),
    # Fried sweets count only the oil the dough actually absorbs, not the
    # frying oil, or the macro sum runs past 100 g per 100 g.
    ("Thekua", "1 piece (48 g)", 48, [("atta", 30), ("jaggery", 15), ("oil", 6)], 48),
    ("Khaja", "1 piece (50 g)", 50, [("maida", 30), ("sugar", 14), ("oil", 8)], 50),

    # Chhattisgarh
    ("Faraa", "3 pieces (95 g)", 95, [("rice_flour", 45), ("urad_dal", 8), ("oil", 4)], 95),
    ("Bafauri", "3 pieces (80 g)", 80, [("chana_dal", 40), ("onion", 10), ("oil", 4)], 80),
    ("Aamat", "1 cup (160 g)", 160, [("bamboo_shoot", 60), ("toor_dal", 15), ("oil", 6)], 160),

    # Goa
    ("Fish curry, Goan", "1 cup (160 g)", 160, [("fish", 95), ("coconut_fresh", 30), ("tamarind", 6), ("oil", 8)], 160),
    ("Chicken xacuti", "1 cup (160 g)", 160, [("chicken_thigh", 90), ("coconut_dry", 20), ("onion", 20), ("oil", 12)], 160),
    ("Pork vindaloo", "1 cup (155 g)", 155, [("pork", 90), ("onion", 20), ("oil", 12)], 155),
    ("Sorpotel", "1 cup (150 g)", 150, [("pork", 85), ("liver", 15), ("onion", 20), ("oil", 12)], 150),
    ("Bebinca", "1 piece (80 g)", 80, [("maida", 20), ("coconut_fresh", 25), ("sugar", 20), ("egg", 20), ("ghee", 10)], 80),

    # Gujarat
    ("Fafda", "1 plate (45 g)", 45, [("besan", 30), ("oil", 14)], 45),
    ("Khaman", "2 pieces (110 g)", 110, [("besan", 40), ("curd", 15), ("sugar", 6), ("oil", 6)], 110),
    ("Sev tameta", "1 cup (130 g)", 130, [("tomato", 90), ("besan", 15), ("oil", 12)], 130),
    ("Bhakhri, wheat", "1 piece (40 g)", 40, [("atta", 35), ("oil", 6)], 40),

    # Haryana
    ("Bathua raita", "1 cup (130 g)", 130, [("curd", 100), ("amaranth_leaves", 30)], 130),
    ("Methi gajar sabzi", "1 cup (105 g)", 105, [("carrot", 80), ("fenugreek_leaves", 40), ("oil", 8)], 105),

    # Himachal Pradesh
    ("Chana madra", "1 cup (165 g)", 165, [("kabuli_chana", 45), ("curd", 60), ("ghee", 10)], 165),
    ("Siddu", "1 piece (95 g)", 95, [("atta", 50), ("urad_dal", 10), ("oil", 5)], 95),
    ("Babru", "1 piece (55 g)", 55, [("atta", 35), ("urad_dal", 12), ("oil", 12)], 55),

    # Jharkhand
    ("Dhuska", "2 pieces (75 g)", 75, [("rice_raw", 35), ("chana_dal", 12), ("oil", 14)], 75),
    ("Chilka roti", "1 piece (90 g)", 90, [("rice_raw", 40), ("chana_dal", 12), ("oil", 5)], 90),

    # Karnataka
    ("Chitranna", "1 cup (180 g)", 180, [("rice_raw", 70), ("peanut", 8), ("curry_leaves", 2), ("oil", 9)], 200),
    ("Vangi bath", "1 cup (180 g)", 180, [("rice_raw", 65), ("brinjal", 40), ("coconut_dry", 8), ("oil", 10)], 205),

    # Kerala
    ("Erissery", "1 cup (165 g)", 165, [("pumpkin", 80), ("lobia", 20), ("coconut_fresh", 25), ("oil", 6)], 165),
    ("Kalan", "1 cup (160 g)", 160, [("plantain_green", 60), ("curd", 60), ("coconut_fresh", 20), ("oil", 5)], 160),
    ("Beetroot pachadi", "1 cup (155 g)", 155, [("beetroot", 70), ("curd", 60), ("coconut_fresh", 15), ("oil", 4)], 155),
    ("Kappa puzhukku", "1 cup (150 g)", 150, [("tapioca", 130), ("coconut_fresh", 20), ("oil", 5)], 150),

    # Madhya Pradesh
    ("Bhutte ka kees", "1 cup (140 g)", 140, [("maize_tender", 110), ("milk", 40), ("ghee", 8)], 140),
    ("Dal bafla", "1 plate (165 g)", 165, [("atta", 55), ("toor_dal", 25), ("ghee", 15)], 165),

    # Maharashtra
    ("Bharli vangi", "1 cup (135 g)", 135, [("brinjal", 100), ("peanut", 15), ("coconut_dry", 10), ("oil", 12)], 135),
    ("Zunka", "1 cup (100 g)", 100, [("besan", 35), ("onion", 25), ("oil", 10)], 100),
    ("Thalipeeth", "1 piece (60 g)", 60, [("jowar", 20), ("besan", 12), ("rice_flour", 8), ("onion", 15), ("oil", 8)], 60),
    ("Amti", "1 cup (170 g)", 170, [("toor_dal", 30), ("jaggery", 5), ("tamarind", 4), ("oil", 6)], 170),
    ("Solkadhi", "1 glass (190 g)", 190, [("coconut_fresh", 35), ("tamarind", 5), ("water", 150)], 190),

    # Manipur
    ("Eromba", "1 cup (120 g)", 120, [("potato", 80), ("bamboo_shoot", 30), ("green_chilli", 8), ("fish", 10)], 120),
    ("Singju", "1 cup (75 g)", 75, [("cabbage", 50), ("peas_fresh", 10), ("besan", 10), ("green_chilli", 5)], 75),
    ("Kangshoi", "1 bowl (180 g)", 180, [("bottle_gourd", 60), ("potato", 40), ("onion", 15), ("oil", 4)], 180),

    # Meghalaya
    ("Jadoh", "1 cup (200 g)", 200, [("rice_raw", 65), ("pork", 45), ("onion", 15), ("oil", 8)], 200),
    ("Doh khleh", "1 cup (120 g)", 120, [("pork", 90), ("onion", 25), ("green_chilli", 5)], 120),
    ("Tungrymbai", "1 cup (110 g)", 110, [("soya_bean", 45), ("sesame", 10), ("oil", 10)], 110),

    # Mizoram
    ("Bai", "1 cup (150 g)", 150, [("spinach", 70), ("bamboo_shoot", 25), ("pork", 20)], 150),
    ("Misa mach poora", "1 plate (105 g)", 105, [("prawns", 100), ("oil", 6)], 105),
    ("Vawksa rep", "1 cup (105 g)", 105, [("pork", 100), ("oil", 4)], 105),

    # Nagaland
    ("Smoked pork with bamboo shoot", "1 cup (140 g)", 140, [("pork", 95), ("bamboo_shoot", 35), ("oil", 5)], 140),
    ("Galho", "1 cup (200 g)", 200, [("rice_raw", 55), ("spinach", 40), ("pork", 25), ("oil", 5)], 205),

    # Odisha
    ("Pakhala bhata", "1 bowl (250 g)", 250, [("rice_raw", 60), ("curd", 40), ("water", 120)], 260),
    ("Dalma", "1 cup (185 g)", 185, [("toor_dal", 30), ("pumpkin", 30), ("plantain_green", 25), ("oil", 6)], 185),
    ("Santula", "1 cup (145 g)", 145, [("bottle_gourd", 50), ("brinjal", 30), ("potato", 30), ("tomato", 20), ("oil", 6)], 145),
    ("Besara", "1 cup (140 g)", 140, [("bottle_gourd", 60), ("brinjal", 40), ("mustard_seed", 8), ("oil", 8)], 140),
    ("Macha besara", "1 cup (155 g)", 155, [("fish", 95), ("mustard_seed", 8), ("tomato", 20), ("oil", 10)], 155),
    ("Rasabali", "2 pieces (125 g)", 125, [("paneer", 45), ("milk", 60), ("sugar", 22), ("oil", 8)], 125),

    # Punjab
    ("Amritsari fish", "1 plate (105 g)", 105, [("fish", 100), ("besan", 12), ("oil", 14)], 105),
    ("Pindi chole", "1 cup (170 g)", 170, [("kabuli_chana", 50), ("onion", 20), ("oil", 10)], 170),

    # Rajasthan
    ("Dal baati churma", "1 plate (175 g)", 175, [("atta", 60), ("toor_dal", 25), ("ghee", 22), ("sugar", 8)], 175),
    ("Gatte ki sabzi", "1 cup (150 g)", 150, [("besan", 35), ("curd", 55), ("oil", 12)], 150),
    ("Ker sangri", "1 cup (90 g)", 90, [("cluster_beans", 60), ("oil", 14)], 90),
    ("Laal maas", "1 cup (160 g)", 160, [("mutton", 95), ("curd", 25), ("onion", 20), ("oil", 14)], 160),
    ("Papad ki sabzi", "1 cup (140 g)", 140, [("besan", 20), ("curd", 60), ("oil", 8)], 140),
    ("Ghevar", "1 piece (80 g)", 80, [("maida", 30), ("sugar", 25), ("ghee", 15), ("milk", 15)], 80),
    ("Mirchi vada", "1 piece (95 g)", 95, [("green_chilli", 40), ("potato", 35), ("besan", 20), ("oil", 16)], 95),

    # Sikkim
    ("Sel roti", "1 piece (70 g)", 70, [("rice_flour", 45), ("sugar", 10), ("ghee", 8), ("milk", 10)], 70),
    ("Gundruk soup", "1 bowl (190 g)", 190, [("mustard_leaves", 40), ("potato", 30), ("oil", 4)], 190),
    ("Phagshapa", "1 cup (140 g)", 140, [("pork", 85), ("radish", 45), ("oil", 8)], 140),

    # Tamil Nadu
    ("Vatha kuzhambu", "1 cup (170 g)", 170, [("tamarind", 12), ("toor_dal", 8), ("onion", 15), ("oil", 12)], 170),
    ("Paruppu usili", "1 cup (105 g)", 105, [("toor_dal", 30), ("french_beans", 60), ("oil", 8)], 105),
    ("Adai", "1 piece (105 g)", 105, [("chana_dal", 25), ("toor_dal", 15), ("rice_raw", 20), ("oil", 8)], 105),
    ("Kothu parotta", "1 plate (165 g)", 165, [("maida", 55), ("egg", 30), ("onion", 20), ("oil", 16)], 165),
    ("Meen kuzhambu", "1 cup (160 g)", 160, [("fish", 95), ("tamarind", 8), ("coconut_fresh", 15), ("oil", 10)], 160),

    # Telangana
    ("Hyderabadi haleem", "1 cup (165 g)", 165, [("mutton", 55), ("atta", 25), ("chana_dal", 12), ("ghee", 15)], 165),
    ("Mirchi ka salan", "1 cup (140 g)", 140, [("green_chilli", 55), ("peanut", 18), ("sesame", 8), ("oil", 14)], 140),
    ("Bagara baingan", "1 cup (145 g)", 145, [("brinjal", 100), ("peanut", 15), ("sesame", 8), ("coconut_dry", 8), ("oil", 14)], 145),
    ("Sarva pindi", "1 piece (75 g)", 75, [("rice_flour", 40), ("chana_dal", 12), ("peanut", 8), ("oil", 12)], 75),
    ("Double ka meetha", "1 cup (130 g)", 130, [("bread_white", 45), ("milk", 70), ("sugar", 22), ("ghee", 12)], 130),

    # Tripura
    ("Chakhwi", "1 cup (160 g)", 160, [("bamboo_shoot", 60), ("plantain_green", 40), ("pork", 20), ("oil", 4)], 160),
    ("Wahan mosdeng", "1 cup (115 g)", 115, [("pork", 90), ("onion", 25), ("green_chilli", 6)], 115),

    # Uttar Pradesh
    ("Tehri", "1 cup (200 g)", 200, [("rice_raw", 65), ("potato", 35), ("peas_fresh", 20), ("carrot", 15), ("oil", 10)], 215),
    ("Bedmi puri", "1 piece (55 g)", 55, [("atta", 30), ("urad_dal", 12), ("oil", 14)], 55),
    ("Galouti kebab", "3 pieces (105 g)", 105, [("mutton_lean", 85), ("besan", 8), ("onion", 10), ("ghee", 10)], 105),
    ("Petha", "2 pieces (90 g)", 90, [("ash_gourd", 60), ("sugar", 45)], 90),

    # Uttarakhand
    ("Kafuli", "1 cup (150 g)", 150, [("spinach", 80), ("fenugreek_leaves", 25), ("rice_flour", 8), ("oil", 6)], 150),
    ("Chainsoo", "1 cup (165 g)", 165, [("urad_dal", 40), ("onion", 10), ("oil", 8)], 165),
    ("Aloo ke gutke", "1 cup (130 g)", 130, [("potato", 120), ("coriander_leaves", 5), ("oil", 9)], 130),
    ("Bhatt ki churkani", "1 cup (170 g)", 170, [("soya_bean", 40), ("rice_flour", 6), ("oil", 8)], 170),
    ("Jhangora kheer", "1 cup (190 g)", 190, [("rice_raw", 30), ("milk", 130), ("sugar", 22)], 190),

    # West Bengal
    ("Macher jhol", "1 cup (175 g)", 175, [("fish", 95), ("potato", 40), ("tomato", 20), ("oil", 12)], 175),
    ("Kosha mangsho", "1 cup (150 g)", 150, [("mutton", 95), ("curd", 25), ("onion", 30), ("oil", 14)], 150),
    ("Begun bhaja", "3 pieces (105 g)", 105, [("brinjal", 100), ("oil", 14)], 105),
    ("Doi maach", "1 cup (155 g)", 155, [("fish", 95), ("curd", 45), ("onion", 15), ("oil", 10)], 155),

    # Delhi
    ("Nihari", "1 cup (170 g)", 170, [("mutton", 90), ("atta", 12), ("onion", 20), ("oil", 14)], 170),

    # Jammu and Kashmir
    ("Yakhni, mutton", "1 cup (165 g)", 165, [("mutton", 90), ("curd", 55), ("oil", 10)], 165),
    ("Dum aloo, Kashmiri", "1 cup (145 g)", 145, [("potato", 100), ("curd", 30), ("oil", 14)], 145),
    ("Haak saag", "1 cup (130 g)", 130, [("spinach", 130), ("oil", 8)], 130),
    ("Modur pulao", "1 cup (180 g)", 180, [("rice_raw", 65), ("ghee", 10), ("sugar", 8), ("raisin", 6), ("cashew", 6)], 200),

    # Ladakh
    ("Skyu", "1 bowl (210 g)", 210, [("atta", 45), ("potato", 35), ("carrot", 20), ("oil", 5)], 210),
    ("Butter tea", "1 cup (195 g)", 195, [("milk", 40), ("butter", 8), ("water", 150)], 195),

    # Lakshadweep and Andaman
    ("Tuna curry, coconut", "1 cup (155 g)", 155, [("fish", 95), ("coconut_fresh", 25), ("tamarind", 5), ("oil", 8)], 155),
]


def load_ifct(path):
    with open(path, encoding="utf-8") as fh:
        return {row["name"]: row for row in json.load(fh)}


def macros(key, ifct):
    """Return per-100 g (kcal, protein, carbs, fat, fiber) for a recipe key."""
    if key in PANTRY:
        return PANTRY[key]
    name = IFCT.get(key)
    if name is None:
        raise KeyError(f"unmapped ingredient {key!r}")
    row = ifct.get(name)
    if row is None:
        raise KeyError(f"{key!r} maps to {name!r}, absent from ifct.json")
    return (
        row["kcal_per_100g"], row["protein_per_100g"],
        row["carbs_per_100g"], row["fat_per_100g"], row["fiber_per_100g"],
    )


def compute(recipe, ifct):
    name, serving_desc, serving_g, ingredients, yield_g = recipe
    totals = [0.0] * 5
    for key, grams in ingredients:
        if grams <= 0:
            continue
        for i, per100 in enumerate(macros(key, ifct)):
            totals[i] += per100 * grams / 100.0
    per100 = [round(t * 100.0 / yield_g, 1) for t in totals]
    return {
        "name": name,
        "serving_desc": serving_desc,
        "serving_grams": serving_g,
        "kcal_per_100g": per100[0],
        "protein_per_100g": per100[1],
        "carbs_per_100g": per100[2],
        "fat_per_100g": per100[3],
        "fiber_per_100g": per100[4],
        "locale": "IN",
    }


def usable(item):
    """The same bar the OFF and FNDDS converters apply, so one bad recipe line
    cannot put an impossible food in front of a user."""
    kcal = item["kcal_per_100g"]
    p, c, f = item["protein_per_100g"], item["carbs_per_100g"], item["fat_per_100g"]
    if not 0 < kcal <= 900:
        return False
    if any(not 0 <= v <= 100 for v in (p, c, f, item["fiber_per_100g"])):
        return False
    if p + c + f > 100:
        return False
    return 0 < item["serving_grams"] <= 1000


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--outdir", default="data/food")
    ap.add_argument("--ifct", default=None, help="defaults to <outdir>/ifct.json")
    ap.add_argument("--exclude", default=None, help="defaults to <outdir>/au_in_dishes.json")
    args = ap.parse_args()

    ifct = load_ifct(args.ifct or os.path.join(args.outdir, "ifct.json"))

    # au_in_dishes.json sorts first and wins any collision, so a name it already
    # carries would make the computed row dead weight in the index.
    with open(args.exclude or os.path.join(args.outdir, "au_in_dishes.json"), encoding="utf-8") as fh:
        taken = {row["name"].strip().lower() for row in json.load(fh)}

    items, skipped, dropped = [], [], []
    seen = set()
    for recipe in RECIPES:
        item = compute(recipe, ifct)
        key = item["name"].strip().lower()
        if key in taken:
            skipped.append(item["name"])
            continue
        if key in seen:
            raise ValueError(f"duplicate recipe name {item['name']!r}")
        if not usable(item):
            dropped.append((item["name"], item["kcal_per_100g"]))
            continue
        seen.add(key)
        items.append(item)

    items.sort(key=lambda x: x["name"])
    out = os.path.join(args.outdir, "in_dishes.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    print(f"{out}: {len(items)} dishes", file=sys.stderr)
    if skipped:
        print(f"skipped {len(skipped)} already in au_in_dishes.json: {', '.join(skipped)}", file=sys.stderr)
    if dropped:
        print(f"dropped {len(dropped)} failing the quality bar: {dropped}", file=sys.stderr)


if __name__ == "__main__":
    main()
