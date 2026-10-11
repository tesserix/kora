# Kora food data expansion

Prepared 2026-10-12. This report describes the local implementation and
validation. Production has not been changed, and embeddings have not been
generated against a paid provider.

## Result

The committed snapshots contain **54,472 source rows across 23 files**. A fresh
canonical import into an isolated, migrated Postgres database inserted
**52,480 distinct foods** after barcode and name/brand deduplication. Running
the existing small seed set added 42 entries, bringing that validation database
to **52,522 foods**. The user's earlier 27,436-food production count was not
queried or independently verified in this work.

There are 26 additional nullable nutrient fields. Existing calories, protein,
carbohydrate, fat and fibre remain intact. New fields cover total sugar,
saturated fat, cholesterol, sodium, calcium, iron, potassium, magnesium,
phosphorus, zinc, selenium, iodine, vitamins A/C/D/E/K, B1/B2/B3/B6/B12 and
folate. Separate fields retain vitamin A RE versus RAE, vitamin D versus D
equivalents, and folate versus dietary folate equivalents.

Published values present in the validation index:

| Measurement | Foods | Coverage |
|---|---:|---:|
| Sodium | 50,946 | 97.0% |
| Total sugar | 47,716 | 90.9% |
| Saturated fat | 50,076 | 95.3% |
| Cholesterol | 37,623 | 71.6% |
| Vitamin C | 36,091 | 68.7% |
| Vitamin D, excluding separately stored equivalents | 33,094 | 63.0% |

Unknown values remain NULL in Postgres and are omitted from food JSON.
Measured zero remains zero. Consumers must distinguish those states when
calculating summaries or making nutrient-based classifications.

## New coverage

| Snapshot | Country / market | Source rows |
|---|---|---:|
| CoFID 2021 | UK | 1,362 |
| MEXT English 2015 tables | Japan | 1,916 |
| Open Food Facts | UK | 5,000 |
| Open Food Facts | France | 5,000 |
| Open Food Facts | Brazil | 5,000 |
| Open Food Facts | Mexico | 5,000 |
| Open Food Facts | South Africa | 711 |
| Open Food Facts | United Arab Emirates | 603 |
| Open Food Facts | Japan | 1,126 |
| Open Food Facts | Singapore | 619 |
| Open Food Facts | Thailand | 689 |

AU/NZ/IN OFF snapshots retain all eligible products. New country snapshots
are capped at 5,000 each, preferring more complete nutrient records. Their
combined 23,748 rows and the 3,278 new national-reference rows are source
counts before cross-file deduplication. Countries with fewer eligible
products are not padded with incomplete data or invented foods.

Country metadata now covers 13 locales including the existing US reference
foods. Timezone-derived country preferences boost ranking without filtering
cross-country meals. Barcode lookups read OFF market tags; weekly refreshes
use the same supported country catalog. An unclassified live barcode retains
the existing AU fallback when inserted. Products sold in several markets use
the first matching country in sorted snapshot order, so one stored row does
not represent every market simultaneously.

The new African, Middle Eastern and Latin American coverage is packaged-food
coverage. It does not substitute for national generic-food or prepared-dish
tables. Japan's English table is the official 2015 edition, not the newer
Japanese-language edition. CoFID records without a complete usable set of
core macros, including AOAC fibre, are excluded; NSP is not substituted for
AOAC fibre and trace markers are not converted to zero.

## Conversion and persistence decisions

- AFCD saturated fat uses the **grams** column, not the separate percentage
  of total fatty acids column. FSANZ's kilojoules still convert to kcal using
  4.184. Vitamin D equivalents remain separate from D2+D3.
- The pinned IFCT transcription expresses micronutrients in **grams**:
  sodium, cholesterol, minerals and vitamin C scale by 1,000 for mg; vitamin
  components scale by 1,000,000 for micrograms. Vitamin A RE is calculated
  from retinol plus beta-carotene equivalents divided by six; the
  transcription's generic aggregate vitamin A column is not mistaken for RE.
- USDA nutrient identifiers distinguish kcal from kJ, RAE from IU, and total
  vitamin D in micrograms from its IU representation. Both the Python FNDDS
  converter and Go SR Legacy converter retain optional nutrient values.
- OFF's canonical nutrient amounts are gram-based. The shared Go decoder
  and offline converter scale them to the mg/microgram field units. OFF
  vitamin A is omitted because its definition is not reliably identified as
  RE or RAE. Numeric strings are supported; non-finite or implausible optional
  values remain unknown. HTTP product responses are bounded at 2 MiB.
- CoFID tables join by food code, not row position. MEXT parentheses denote
  published estimates and are parsed as values; `Tr`, `N`, blanks, dashes and
  censored `<…` values remain unknown. Unicode unit notation is normalized.
- Indian recipes emit a nutrient only when every contributing ingredient
  supplies it. No missing pantry or salt/spice value is treated as zero.
  Their values remain recipe estimates based on raw ingredients and cooked
  yield; heat destruction and leaching are not modeled. Only 24 of the 335
  generated recipes currently have complete inputs for sodium and sugar.
- Migration 000063 adds nullable double-precision columns with finite,
  nonnegative physical bounds. Adding the fields does not rewrite existing
  food identities or embeddings.
- Ingestion fills only missing nutrient values from the owning provenance,
  matching a stable barcode when available and otherwise exact name/brand.
  It preserves measured zero, existing corrections and retired rows.
  Rerunning an import is safe after a partial failure. A later reference
  release does not automatically replace already-known nutrient values.
- OFF refresh updates published values, including measured zero, without
  erasing known values when a later payload omits them. Country tags match
  exactly, and international names use the same character-count limit as the
  Python converter.
- Food responses and mobile food types carry the new optional fields. Search
  and meal source badges recognize AFCD/AUSNUT/IFCT/USDA/CoFID/MEXT/OFF;
  computed recipes display "Recipe estimate". About-screen credits and the
  shipped [NOTICE](../api/data/food/NOTICE.md) identify source terms.

The existing canonical food API remains the read boundary; no new endpoint,
service, runtime package or external lookup is introduced by the reference
datasets. Food data is shared public reference information. Untrusted source
values are validated at conversion, decoding and storage boundaries;
backfills cannot change another provenance's measurements or revive retired
rows. Existing authentication and user-owned object scopes are unchanged.

The local food table and its indexes occupied about 38.2 MiB without vectors.
A 768-dimensional float vector adds 3,072 bytes per food before index overhead.
New food identities will need the existing embedding backfill; adding nutrient
fields to an existing identity does not require another embedding. Production
request traffic, p99 latency, provider billing and seed-Job deadlines were not
measured or changed. The OFF snapshot cap bounds this initial expansion; the
weekly refresh can grow the catalog further.

## Source research still requiring a decision

| Requested source | Evidence and status |
|---|---|
| FAO/INFOODS West Africa 2019 | The [official workbook](https://www.fao.org/fileadmin/user_upload/faoweb/2020/WAFCT_2019.xlsx), Introduction sheet, permits use in non-commercial products/services and directs commercial-use requests to FAO. No commercial permission was supplied. It is not included in the seed. |
| ASEANFOODS 2014 | The [official publication](https://inmu.mahidol.ac.th/aseanfoods/doc/OnlineASEAN_FCD_V1_2014.pdf), copyright page, requires permission for redistribution and says commercial uses may incur fees. It is not included. The working institute host is `inmu.mahidol.ac.th`; the `www` host has a certificate-name mismatch. |
| LATINFOODS | The [FAO directory](https://www.fao.org/infoods/infoods/tables-and-databases/latin-america/en/) points to individual national databases, including TBCA and TACO, rather than a single verified licensed bulk export. Commercial reuse and a reproducible source file still need verification. Brazilian and Mexican OFF snapshots provide packaged coverage meanwhile. |
| Newer Japanese edition | The [current Japanese tables](https://www.mext.go.jp/a_menu/syokuhinseibun/mext_00001.html) are available, but this implementation uses the official English 2015 table rather than inventing translations or joining changed food definitions to older English names. |

A literal-name audit found chicken shawarma and a packaged feijoada meal.
Moringa leaves are present under "Drumstick leaves", although "moringa" is not
a literal indexed name. Literal "dim sum", "jollof", "tagine" and "poutine"
remain absent. This is a name audit, not proof that equivalent dishes cannot
be found semantically. No high-confidence global aliases were invented to
force raw ingredients to match cooked dishes.

## Reproduction and validation

Input and generated-file SHA-256 hashes, row counts and converter commands
are recorded in [SOURCES.md](../api/data/food/SOURCES.md). The original public
files were downloaded over verified HTTPS. The 1.27 GB OFF export was assembled
from byte ranges, checked for its full expected length and validated with
`gzip -t` before conversion. Raw export metadata and contributor fields are
not copied into the food snapshots.

Tests first reproduced discarded zero/sodium values, missing reseed
backfills, missing USDA micronutrients, lost barcode/refresh values, country
tag prefix matches, international-name byte-count rejection, and incorrect
source badges. Their corresponding regressions then passed. One oversized-
response regression overlapped an edit and failed to compile; it was rerun
against stable unbounded code to reproduce the expected failure, then passed
with the response bound restored.

Checks actually run:

| Check | Status |
|---|---|
| `go run ./cmd/migrate` on isolated pgvector/Postgres 15 databases | Passed |
| Migration 000063 up/down/up on a temporary table; zero accepted and negative/NaN/infinity rejected | Passed, 26 → 0 → 26 columns |
| Fresh `go run ./cmd/ingest -food-dir data/food` | Passed, 52,480 inserted; the small seed set was initially absent and its flat-white alias unresolved |
| `go run ./cmd/seed` | Passed, 42 inserted |
| Repeat `go run ./cmd/ingest -food-dir data/food` | Passed, 0 inserted and all 10 aliases resolved |
| `gofmt -l .` | Reports the pre-existing modified `internal/social/service_test.go`; all changed nutrition Go files are formatted |
| `go vet ./...` and `go build ./...` | Passed |
| `go test -race -p 1 ./...` with isolated `TEST_DATABASE_URL` | Passed; affected nutrition packages were checked again after the final changes |
| `go test -race -p 1 ./internal/nutrition/...` | Passed |
| `pytest api/scripts/tests/ -q` | Passed, 7 converter tests |
| `ruff check api/scripts` and `ruff format --check api/scripts` | Passed; existing compact recipe definitions retain their review layout |
| Strict mypy on the three new Python modules | Passed using pinned temporary `types-openpyxl==3.1.5.20260827` stubs |
| `npx expo customize tsconfig.json` and `npx tsc --noEmit` | Passed; tsconfig has no resulting diff |
| Default full `npm test -- --runInBand` | Failed only the 5 pre-existing Firebase persistence cases requiring Node VM modules |
| Full mobile suite with VM modules globally enabled | Failed because that flag conflicts with 54 other suites' existing mocks |
| Normal Jest run selecting the other suites | Passed, 261 suites / 2,551 tests |
| Firebase persistence suite separately with `NODE_OPTIONS=--experimental-vm-modules` | Passed, 1 suite / 5 tests; all 262 suites were exercised across the two environments |
| Focused About, source-badge and meal tests | Passed, 3 suites / 28 tests |
| `npm run lint` | Passed with 45 existing warnings and no errors |
| `npx expo export --platform web` | Passed; About route compiled. Exported HTML contains the startup shell, so this does not substitute for device UI inspection |
| `npx expo-doctor` | Failed version alignment only: 6 existing Expo packages are one patch behind the installed SDK's expectations; 20/21 checks passed |
| iOS/Android device interaction | Skipped: no device session was used; no native module or native configuration changes are part of this work |
| `govulncheck ./...` | Reports 5 reachable vulnerabilities in the existing `golang.org/x/net` dependency and one additional required-module finding |
| `npm audit --audit-level=high` | Reports existing dependencies: 8 moderate, 56 high and 1 critical |
| `gitleaks git --redact` | Reports 8 historical findings; separate scans of nutrition, converter and food-data scopes passed with no leaks |
| `trivy fs --scanners vuln,secret,misconfig .` | Completed with existing dependency findings, including high/critical issues, and one low Dockerfile misconfiguration |
| `git diff --check` | Passed |

Unrelated dependency, authentication, CI, social and tracking changes already
present in the workspace are preserved. Existing scanner findings and the
default Firebase/Jest environment conflict are not suppressed or silently
reported as passing.

The changes are prepared as two isolated draft PRs. Nutrient retention is
[PR #601](https://github.com/tesserix/kora/pull/601); this regional expansion
is stacked on its branch. Both isolated branches passed Go vet/build,
nutrition race tests, their converter tests and Ruff checks, TypeScript, and
the relevant About/source-badge/meal suites. Temporary mobile checks reused
the workspace's installed dependencies; unrelated dependency edits are not
included in either PR.

## Deployment and rollback

Review and apply migration 000063 through the existing migration Job before
deploying code that writes or selects the new columns. The registered source
files are shipped by the existing image and loaded by its directory-based
ingestion command. Source attribution must ship with the client changes.

The seed/backfill can be rerun after interruption and preserves existing food
IDs and embeddings. New foods remain in the embedding backlog until the
existing embedding command runs. No paid embedding call, merge, production
sync or database migration was triggered by this validation.

An application rollback can leave the additive nullable columns in place.
The down migration removes the new nutrient data and therefore needs explicit
production approval and a backup if it is ever used outside the scratch test.
