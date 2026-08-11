# Handoff — 2026-08-11 — Food logging fixes, units, meals, reminders, embeddings

All work below is **merged to main and green** (full Go suite; 1,046 mobile tests / 141 suites).
Zero open PRs. Nothing is half-finished in the repo — what remains is operational or follow-up.

## What shipped

| PR | What it fixed |
|---|---|
| — (`afe2db0`) | Barcode scans used a flat 100 g instead of the product's own `serving_grams`. A NESCAFÉ sachet logged as 545 kcal instead of ~90. |
| — (`d701c8f`) | Weak Otto matches rendered as unselected "tap to confirm" rows and disabled the CTA at "Add 0 items to diary" — the capture was unloggable. Now the server's top match is preselected, captioned as a guess. |
| #124 | Food unit support: `base_unit` + `serving_units` on `food_items`, `entered_amount`/`entered_unit` on `food_logs` and `saved_meal_items`, `api/internal/units`, OFF ingest reading `serving_quantity_unit`, `cmd/backfillunits`, client `formatPortion` + `PortionField`. |
| #125 | Multi-ingredient meals: blank-slate creation, "+ Add ingredient" via `FoodPicker`, diary long-press multi-select compose, entered units on the batch-log endpoint. |
| #126 | Reminders reachable from Settings; first-class weight check-in reminder that skips when the user already weighed in that day. |
| #127 | Embed a food when a barcode scan ingests it; `cmd/embed` retries, counts failures, and stops reporting success when it embedded nothing. |

Specs and plans for each are in `docs/superpowers/specs/` and `docs/superpowers/plans/`, dated
2026-08-09 through 2026-08-11.

## THE THREE THINGS THAT ACTUALLY NEED DOING

### 1. `cmd/backfillunits` has never been run — do the dry run first

`base_unit` and `serving_units` are populated for newly ingested rows only. Every pre-existing row
still carries the migration default. Concretely: the user's own milk row
(barcode `9310232956596`, a 300 **ml** product) still reports `base_unit = 'g'` and will render as
grams until this runs.

**Run `backfillunits -dry-run` and read the output before the real pass.** `units.Fallback` matches
on word boundaries, which fixed "Rolled oats" but not the standalone-word cases — "Rice crackers"
still gets rice's 158 g cup, roughly 10× too heavy, and "Milk chocolate" inherits milk's density.
The dry run names `base_unit` transitions and samples the `Fallback`-sourced rows; the sample is
capped at 25, so it cannot prove the absence of bad rows, only surface some.

The job is idempotent and skips rows that already have units.

### 2. No alert on `kora_food_index_missing` — this is the one not to forget

`cmd/embed` now exits non-zero **only** when `embedded == 0 && failed > 0`. That was a deliberate
call: any-failure-is-red meant one permanently un-embeddable row at the head of
`RowsMissingEmbedding` (`ORDER BY created_at`) would red-line every deploy forever, and a
rate-limited sync would burn the daily Gemini quota across six chain re-runs
(`backoffLimit: 5`, `restartPolicy: OnFailure`, runs on every ArgoCD sync).

The honest cost: **the 2026-08-02 incident shape is now green** — that run embedded some rows and
failed 69. The compensating detector is the `kora_food_index_missing` gauge
(`internal/metrics/metrics.go:83-87`, refreshed by `foodindex.go`, 60s default). A repo-wide grep
found **no alert rule, recording rule, or dashboard for it**. Until one exists, a slow embedding
leak has no owner. Alert rules likely live in `tesserix-k8s`.

### 3. On-device verification of merged work

Use the **iPhone 17 Pro** simulator, not the Pro Max.

- **Nested modals (#125), highest risk.** `FoodPicker` is a `Sheet` (a `Modal`) now rendered from
  inside `SavedMealSheet`'s own `Modal` — the first such nesting in the app. The test suite mocks
  both away, so CI says nothing about it. Check: does the inner sheet present above the outer one;
  does drag-to-dismiss respond (RNGH gestures inside a `Modal` need a `GestureHandlerRootView` in
  scope); does `autoFocus` raise the keyboard; does dismissing the picker leave the outer sheet
  intact.
- **iOS cold launch and Firebase (#126).** Does `AppState` fire `active` on a cold launch, and has
  Firebase restored the session by then? `src/offline/drainTriggers.ts` documents that the
  cold-start pass "almost always loses the race". If it loses here too, the launch reconcile
  fetches unauthenticated, `fetchLatestWeighInDate` returns null, and the weight-reminder skip
  silently degrades to "fires anyway".
- **The weight reminder end to end.** Enable it for two minutes out, log a weight, confirm nothing
  fires. Repeat without logging, confirm it does.
- **The unit round trip.** Scan `9300605158641` (NESCAFÉ Mocha) → expect "1 portion", ~90 kcal.
  Scan `9310232956596` (milk) → expect ml, **after** the backfill in item 1.

## Smaller follow-ups, recorded not urgent

**Units / meals**
- `Parse` cannot read the `"1/2 cup (40g)"` fraction form — 9 of 61 seeded `serving_desc` values use it.
- The macro preview stays frozen while stepping servings (deliberate — the client must not derive
  nutrition — but it needs a placeholder or a server-side preview).
- `serving_units` is not returned on food-log reads, so an ml ingredient inside an **existing**
  saved meal still shows a "g" chip on reopen. Verified cosmetic: wrong label, right number.
- Queued/offline diary rows cannot be composed into a meal until they sync.
- `useAddWeight` passes `new Date()` rather than the entry's `logged_at`, so backdating a weigh-in
  still suppresses today's reminder.

**Embeddings**
- `cmd/embed` has no client-side rate limit; ~90/min would keep it under Gemini's 100/min cap.
- `/v1/resolve/barcode` is unrate-limited and shares the same daily quota, so user scan volume can
  starve the embed job.
- Admin-created foods (`POST /v1/admin/foods`) are not embedded at ingest — only the barcode path is.
- A renamed food keeps its stale embedding; `RowsMissingEmbedding` will never re-select it.

**Test hygiene**
- `apps/mobile`: `npm run lint` cannot run (`expo lint` → `Cannot find module 'eslint'`). The
  untracked `apps/mobile/eslint.config.js` in the working tree is pre-existing and was left alone.
- Diary-level `meal_slot` plumbing is pinned only at the sheet level (`objectContaining`).

## How this work was run, if you continue in the same style

Each piece went brainstorm → spec → plan → subagent-driven execution with a per-task review, then a
whole-branch review before merge. That caught real defects — a missed third `applyAllReminders`
call site that ran on every launch, a `lastWeighedAt: null` placeholder handed across two tasks, a
`Fallback` that returned different densities on different calls.

**The pattern worth knowing:** nearly every defect originated in the *plan*, not the
implementation, and concentrated in tasks whose implementation steps were written as prose rather
than as code. Plans with real code in every step produced markedly fewer findings. If you write a
plan, write the code into it.
