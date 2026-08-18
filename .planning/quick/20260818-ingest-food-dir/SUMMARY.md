---
id: 260818-gyj
slug: ingest-food-dir
date: 2026-08-18
status: complete
---

# One `-food-dir` flag instead of nine path flags

## What changed

- **`api/internal/nutrition/ingest/sources.go`** (new) — the source table:
  filename → provenance, one entry per food data file, with the per-source
  notes that used to sit on the flags. `Sources(dir)` resolves it into the
  `path→provenance` map `Run` takes; `AliasFile` is `aliases.json` under the
  same directory.
- **`api/cmd/ingest/main.go`** — nine path flags replaced by one `-food-dir`
  (default `data/food`). `-backfill-normalized` and `-backfill-usda-brands`
  unchanged.
- **`tesserix-k8s` `charts/apps/kora-api/values.yaml`** — seed command passes
  `-food-dir /usr/local/share/kora/food`. Chart bumped 0.1.17 → 0.1.18.

## The part that makes the bug class unrepeatable

The single flag removes the two-repo drift. The remaining way to get it wrong —
declaring a source whose file was never committed — is now caught by
**`TestSourceFilesExist`**, which fails CI in the repo that caused it instead
of crash-looping the seed Job in prod.

`TestNoUndeclaredFoodFiles` covers the other direction: a committed file no
source declares, which is either a source silently not being ingested or a
stale file. Both guards were confirmed to actually fail — a bogus table entry
and a stray `zz_stray.json` each produced the intended failure before being
reverted.

A missing file at runtime stays fatal. After this change that can only mean the
image was built wrong, not that two repos drifted.

## Verification

- `go build ./...`, `go vet`, `gofmt` clean.
- `go test -p 1 ./internal/nutrition/ingest/...` passes.
- Full ingest against an **empty** database inserted **18,829** rows across all
  six provenances (usda 7,727 · off 5,665 · ausnut 3,256 · afcd 1,598 ·
  ifct 522 · curated 61) — so all nine files are genuinely read through the one
  flag. Re-run inserted 0, confirming idempotency.
- kora#227's fix is visible in the same run: **22 rows at exactly 0 kcal**
  (water, tap water, mineral water, diet cola, herbal tea), where the index
  previously held none.
- `helm template` renders:
  `/usr/local/bin/seed && /usr/local/bin/ingest -backfill-usda-brands -food-dir /usr/local/share/kora/food && /usr/local/bin/embed`

## Worth knowing

Verifying this on the local dev database was misleading for a while: a **native
postgres owns `127.0.0.1:5432` while the compose container binds `*:5432`**, so
`localhost` in `DATABASE_URL` and a `docker exec psql` inspect *different*
databases. The ingest looked like a no-op against a DB that already had data.
The real verification was run against an isolated container on port 55432.

## Follow-up not done here

`scripts/afcd_convert.py` was fixed by kora#227 but **`afcd_release3.json` was
never regenerated**, so it still carries 0 zero-energy rows. AUSNUT already
supplies water and the other zero-kcal staples, so nothing is broken — but the
AFCD zero-energy rows stay missing until the file is regenerated from the
source XLSX.
