# Food data: country seeding + weekly in-app refresh

Approved 2026-08-22. Extends the food index to NZ and current US data, and
keeps the packaged-food layer fresh with a weekly scheduled refresh inside the
API — no external CI machinery.

## Problem

The index covers AU well (AFCD + AUSNUT + OFF-AU), India thinly (IFCT 525 +
61 curated dishes, no packaged foods), the US with frozen data (SR Legacy,
discontinued 2018), and NZ not at all. Every data refresh is a human running a
converter and committing JSON.

## Sources decision

| Country | Source | Mode | Why |
|---|---|---|---|
| NZ | OFF `en:new-zealand` slice | snapshot + weekly refresh | barcoded packaged foods; FSANZ (a bi-national AU/NZ agency) reference data already covers NZ generic foods |
| IN | OFF `en:india` slice | snapshot + weekly refresh | first Indian packaged coverage (Amul, Britannia, MTR…) |
| US | USDA FNDDS survey foods | snapshot | ~7k foods **as consumed** with portion weights — the US AUSNUT; replaces reliance on frozen SR Legacy for meals |
| all | OFF recent-changes API | weekly in-app cron | the only upstream that changes weekly |

Rejected: FatSecret as primary (per-call cost, ToS forbids bulk retention);
Edamam for seeding (ToS); scraping retailer sites (licensing, fragility);
GitHub Actions scheduled refresh (private-repo minutes, and the app can do it
itself — user decision); NZ FOODfiles this pass (registration-gated download;
FSANZ reference data plus the OFF NZ slice carries NZ users meanwhile).

Reference datasets (AFCD, AUSNUT, IFCT, FNDDS) release every few years; they
stay committed snapshots loaded by the existing seed Job. Weekly freshness only
makes sense for OFF, and that is what the cron refreshes.

## Design

1. **Converters** — `off_convert.py` gains `--countries au,nz,in --outdir`,
   emitting all slices in one pass over the dump, each row stamped with its
   locale (the mechanism `au_in_dishes.json` already uses). New
   `fndds_convert.py` builds `usda_fndds.json` from the FDC survey-food CSVs
   with per-food portions as serving units.
2. **Locale** — new `LocaleNZ`; `Pacific/Auckland`/`Pacific/Chatham` map to it.
   Scoring treats AU rows as a (weaker) match for NZ users: FSANZ data is
   bi-national, and NZ has no generic rows of its own yet.
3. **Weekly refresh** — `internal/nutrition/refresh`: pulls OFF products
   modified since the last run for AU/NZ/IN via the search API (small deltas,
   never the 1.19 GB dump), applies the exact quality bar `off_convert.py`
   applies, then upserts: new barcodes insert, known barcodes update nutrition
   in place. Soft-deleted rows stay dead (admin retirement wins). State lives
   in a `food_refresh_runs` table; a Postgres advisory lock makes the run
   single-flight across replicas; the runner ticks hourly and fires when a week
   has passed — restart-safe. Wired in `cmd/api` next to the existing
   scheduler, off by default in tests, enabled by config.
4. **Sources table** — `off_nz.json`, `off_in.json`, `usda_fndds.json` join
   `ingest.Sources`; `TestSourceFilesExist` keeps the seed Job honest.

## Non-goals (follow-ups)

- Agent write-back of proposed foods (needs a review queue; separate design).
- US branded foods at scale (FDC branded is ~450k rows; needs a quality filter
  design of its own).
- NZ FOODfiles ingestion once a download without manual registration exists.

## Licensing

FDC data is CC0. OFF is ODbL — attribution already an in-app obligation from
off_au.json; the new slices add no new duty. IFCT stays pinned to the MIT tag.
