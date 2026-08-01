# Design — food index: embeddings + coverage

**Date:** 2026-08-02
**Repos:** `kora` (image, data, ingest) and `tesserix-k8s` (seed Job)

## Problem

Two failures compound each other.

**Embeddings are empty.** `select count(*) from food_items where embedding is not null`
returns **0** in both the local test DB and prod. `cmd/embed` exists and is
correct, but `api/Dockerfile` builds and copies only `api`, `migrate`, `seed`,
`ingest` — so it cannot run in-cluster. This is the same defect PR #67 fixed for
seed/ingest, repeated for embed. The seed Job also receives only `DATABASE_URL`,
never `GEMINI_API_KEY`.

The consequence is measured, not theoretical: `match_score` has exactly three
sources — alias `1.0`, full-text `0.7 + 0.29*s` (clamped to `[0.70, 0.99]`), and
embedding `sim * 0.7`. With no embeddings, the only source of sub-0.70 scores is
dead. Since `TierFor` takes `min(identifyConf, matchScore)`, **`follow_up` is
unreachable and nearly every item lands in `confirm`.** #21's per-item tiers are
correct and inert. Observed scores in prod: 0.717–0.726, every item `confirm`.

**Coverage is 85 items.** A guess that matches nothing is dropped silently
(`resolveGuesses`: `len(cands) == 0 → continue`), so "chicken breast and
lasagne" logs the chicken and never mentions the lasagne. Verified in the app.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Bulk data source | USDA SR Legacy (~7,800) | Public domain, free, no licensing question. Chosen over a ~300-item curated set for coverage breadth |
| SR Legacy names | Ingest verbatim | Preserves every distinction and all 7,800 rows. Shortening to "Beef, round" would collapse hundreds of cuts into one row via the name+brand dedup — a silent coverage loss |
| AU/Indian foods | Hand-authored curated set | **Verified**: SR Legacy returns 0 hits for vegemite, weet-bix, paneer, dosa, dal, idli, samosa, tim tam, lamington. It is US commodity data; it cannot serve these users |
| Threshold tuning | None | Out of scope. Fix the data first, then judge whether 0.90/0.70 are right against real score distributions |

Not verified: whether FNDDS or Branded cover AU/IN foods — the FDC `DEMO_KEY`
rate limit cut the probe short. A free FDC API key would settle it. The curated
set is needed regardless.

## Part 1 — Embedding pipeline

1. `api/Dockerfile`: build `/bin/embed` from `./cmd/embed` and copy it to
   `/usr/local/bin/embed`, alongside the existing three.
2. `tesserix-k8s` `charts/apps/kora-api/values.yaml`: the seed command becomes
   `seed && ingest … && embed`.
3. Same chart's `templates/seed-job.yaml`: add `GEMINI_API_KEY` from the
   existing `{{ .Values.secretEnv.GEMINI_API_KEY }}` key (`gemini_api_key`),
   which the chart already defines but the Job never referenced.

`cmd/embed` selects only rows missing an embedding, so re-running on every
ArgoCD sync is a no-op after the first. An interrupted run resumes next sync.
It exits 0 without a key rather than crashing, so a missing secret degrades to
"no embeddings" rather than a crashlooping Job.

## Part 2 — SR Legacy import

A converter reads USDA's SR Legacy JSON and emits the existing ingest shape.
Nutrient IDs: `1008` kcal, `1003` protein, `1005` carbohydrate, `1004` fat,
`1079` fibre — all already per 100 g in SR Legacy. `serving_grams` comes from
the first `foodPortions` entry when present, else 100 with
`serving_desc: "100 g"`.

The converter runs once locally; its output is committed as
`api/data/food/usda_sr_legacy.json` (~2 MB) with provenance `usda`. The
Dockerfile already copies `data/food`, so no image change is needed for the
data itself.

`cmd/ingest` gains a flag for the new file. Its flags stay explicit
(`-afcd`, `-usda`, plus new ones) rather than becoming a generic list, because
the k8s Job command names each path anyway and explicit flags keep that command
readable.

## Part 3 — Curated AU/Indian dishes

`api/data/food/au_in_dishes.json`, hand-authored, covering everyday Australian
and Indian foods the bulk import cannot: dal, roti, chapati, dosa, idli, sambar,
biryani, paneer dishes, common curries, plus Australian items in the spirit of
the existing `cmd/seed` table.

New constant `ProvenanceCurated Provenance = "curated"`. `provenance` is a
free-text column with no CHECK constraint, so this needs no migration — only the
Go constant and the comment in `000002_phase1_core.up.sql` updated to list it.

Per-100g values are sourced from published composition data and rounded; each
entry is a considered estimate for a home-cooked portion, not a lab measurement.
That is already true of the existing seed table and is acceptable for a
consumer log, but it should be stated rather than implied.

## Error handling

- Missing `GEMINI_API_KEY`: `cmd/embed` logs and exits 0. The Job succeeds and
  the index simply keeps no embeddings — the current behaviour, not a regression.
- A row that fails to embed is logged and skipped; if an entire batch fails,
  `cmd/embed` stops rather than looping forever on rows that never clear.
- Converter: a food missing any required nutrient is skipped with a count
  reported at the end, rather than emitting a zero-calorie row that would later
  read as a real measurement.
- Ingest remains idempotent — existing rows are skipped by the name+brand dedup.

## Testing

**Converter** — a golden test over a small committed fixture of real SR Legacy
records: nutrient IDs map to the right fields, portions resolve, and a record
missing energy is skipped rather than zero-filled.

**Ingest** — the new files load and dedup on re-run.

**Provenance** — `curated` round-trips through insert and read.

No new tests for `cmd/embed`: it is unchanged.

## Verification

Tests will not catch what matters here. After deploy:

1. `select count(*) from food_items where embedding is not null` is non-zero in
   prod.
2. Re-run the exact probe that failed on 2026-08-01: "chicken breast and
   lasagne" must stop silently dropping the lasagne.
3. Confirm embedding-tier matches now occur, producing scores below 0.70 — which
   is what finally makes #21's uncertain row reachable by a real user.
4. Log an Indian dish through the app end to end.

Step 3 is the real acceptance test for this work: it converts #21 from correct-
but-inert into a feature a user can actually encounter.

## Risks

- **First embed run is ~8,000 sequential API calls**, likely 15–25 minutes
  inside the Job. `backoffLimit: 5`, no `activeDeadlineSeconds`, so a slow run
  will not be killed. Later syncs are no-ops.
- **7,800 clinical names make the picker noisier.** Accepted deliberately; a
  separate display name is the honest fix and is explicitly out of scope here.
- **A ~2 MB JSON enters git.** Acceptable once; it should not become a habit of
  committing regenerated dumps.
