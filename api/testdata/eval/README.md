# Kora resolution eval dataset

Golden dataset for the Phase 2 resolution engine. **User-provided** — the real
files here (except the committed `*.sample.*`) are gitignored.

## chat.jsonl (one JSON object per line)
{"phrase": "two eggs and toast", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `phrase`      — the text a user would type/speak.
- `expected_name` — substring expected in the top-1 resolved candidate's item name (case-insensitive).
- `expected_kcal`  — reference kcal for the stated `grams` (for the median-error metric).
- `grams`        — portion the reference kcal is stated for.

## photos/ + photos.jsonl
photos.jsonl: {"file": "photos/omelette.jpg", "expected_name": "Egg", "expected_kcal": 155, "grams": 100}
- `file` is relative to testdata/eval/.

## Thresholds (exit gate)
- chat top-1 id accuracy  >= 0.90
- photo top-1 id accuracy >= 0.80
- resolved-entry correctness (a confident candidate returned) >= 0.90
- median kcal error <= 0.20
- zero hallucinated rows (every candidate has a real food_items.id)
