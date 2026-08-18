---
id: 260818-gyj
slug: ingest-food-dir
date: 2026-08-18
status: in-progress
---

# One `-food-dir` flag instead of nine path flags

## Why

`cmd/ingest` takes nine per-source path flags whose defaults are repo-relative
(`data/food/*.json`). Nothing is mounted there in the image, so the kora-api
seed Job must repeat all nine as absolute paths. A source added to `cmd/ingest`
without a matching line in `tesserix-k8s`'s `charts/apps/kora-api/values.yaml`
makes the Job exit 1 and crash-loop prod.

**That happened three times in one day** — `-ifct` (kora#215), `-ausnut`, and
`-aliases`. A warning comment was written after the first and did not prevent
the second or third. The fix has to be structural, not documentary.

## Shape

- `cmd/ingest` takes one flag, `-food-dir` (default `data/food`).
- The source list — filename → provenance — moves into a table in Go, next to
  the loader it feeds. Adding a source is a one-line change in one repo.
- The alias file is `aliases.json` under the same directory.
- The nine path flags are **removed**, not deprecated. Keeping them as
  overrides would leave the hazard reachable. The only live callers are the
  chart's seed command and `api/Dockerfile` (which copies the whole
  `data/food` tree, so it needs no change).
- `-backfill-normalized` and `-backfill-usda-brands` stay as they are.

## The guard that replaces the comment

A Go test asserts every filename in the source table exists in `api/data/food`.
Drift now fails CI in the repo that caused it, instead of crash-looping the
seed Job in prod. This is the part that makes the class of bug unrepeatable —
the single flag alone only removes the need for the second repo to keep up.

A missing file at runtime stays fatal. After this change that can only mean the
image was built wrong, not that two repos drifted.

## Tasks

1. `api/internal/nutrition/ingest/sources.go` — the source table + a `Sources`
   helper that resolves it against a directory. Test that every listed file
   exists.
2. `api/cmd/ingest/main.go` — replace the nine flags with `-food-dir`.
3. `tesserix-k8s` `charts/apps/kora-api/values.yaml` — seed command passes
   `-food-dir /usr/local/share/kora/food`; rewrite the stale warning comment.
   Bump `Chart.yaml`.

## Verification

- `cd api && go build ./... && go test -p 1 ./internal/nutrition/ingest/...`
- `go run ./cmd/ingest` against dev resolves the same nine files (inserted 0 —
  idempotent re-run).
- `helm template` the chart and read the rendered seed command.
