# Food nutrient retention

Migration 000063 adds 26 nullable per-100 g measurements to the canonical food
index. Existing calories, protein, carbohydrate, fat and fibre remain intact.
New fields cover sugar, saturated fat, cholesterol, sodium, calcium, iron,
potassium, magnesium, phosphorus, zinc, selenium, iodine, vitamins A/C/D/E/K,
B1/B2/B3/B6/B12 and folate. RE/RAE, D/D equivalents and folate/DFE retain
separate source definitions. Field names state grams, mg or micrograms.

Unknown nutrients remain NULL and are omitted from food JSON; measured zero
is preserved. Food responses and mobile types expose the optional fields.
Recipe values remain estimates, and both search and meal source labels
distinguish them from reference data.

## Conversion

AFCD, AUSNUT, IFCT, FNDDS and OFF Python converters and the Go SR Legacy
converter now retain optional measurements. The existing Indian recipe
converter includes a nutrient only when all contributing ingredients have a
value; missing pantry/salt-spice values are not treated as zero. Recipe
calculations use raw ingredients and cooked yield without heat-loss/leaching
factors.

AFCD saturated fat comes from its grams column, not the percentage-of-fatty-
acids column. IFCT's pinned MIT transcription expresses micronutrients in
grams, requiring ×1,000 for mg and ×1,000,000 for micrograms. Its RE value is
retinol plus beta-carotene equivalents divided by six. USDA RAE/microgram IDs
are not confused with IU or kJ IDs. OFF amounts are gram-based; ambiguous OFF
vitamin A is not claimed as RE or RAE. Trace, censored and non-finite optional
values remain unknown.

The original snapshots are regenerated from official public files and IFCT
tag 2.0.5. Source terms and the MIT notice are shipped in
[NOTICE.md](../api/data/food/NOTICE.md), with About-screen attribution.
No runtime package or external lookup is added.

## Persistence and recovery

Ingestion backfills only NULL measurements from the owning provenance. It
matches a stable barcode when present, otherwise exact name/brand, and leaves
retired rows and existing corrections untouched. New columns do not change
food identities or embeddings. OFF refresh replaces changed published values
but never erases known values when the next payload omits them. Its numeric-
string handling is shared with barcode lookup, and HTTP response decoding is
bounded at 2 MiB. Country tags match exactly and name limits count characters.

Migrate before deploying the application/seed command. An application rollback
can keep the additive columns. The down migration drops nutrient values and
requires explicit production approval and a backup outside scratch validation.
Future reference releases do not automatically overwrite known measurements.

## Validation

Regressions first reproduced discarded zero/sodium values, missing reseed
backfills, missing USDA fields, erased barcode/refresh values, country-prefix
matches and international-name byte limits; the corresponding fixes pass.
The oversized-response regression was rerun against stable unbounded code to
show the expected failure before the response bound was restored.

Migration up/down/up passed on isolated pgvector/Postgres 15 with 26 → 0 → 26
columns. Zero was accepted; negative/NaN/infinity values were rejected. The
combined feature workspace passed the full API race suite and a real import
followed by a zero-insert repeat. The isolated PR branch is checked separately
with Go vet/build, nutrition race tests, five converter tests and About/source-
badge/meal tests. Changed Go files, Ruff checks and `git diff --check` pass.

Root-workspace checks also passed TypeScript and lint (existing warnings) and
the web export. Existing Firebase tests need a separate VM-modules environment
from the other Jest suites; all suites were exercised across those environments.
No iOS/Android device session was used. Existing dependency scanner findings,
historical gitleaks findings and Expo patch-alignment warnings are outside this
change. Unrelated workspace changes are excluded from the PR. Production and
paid embedding providers have not been touched.
