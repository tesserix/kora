---
issue: 45
date: 2026-08-23
---

# Tape measurements (#45)

Six tape measurements stored the same way as the existing body-composition
metrics. Decisions confirmed with the user before starting:

- **The common six**: neck, chest, waist, hip, arm, thigh.
- **On `weight_entries`, weight stays required.** Consequence, accepted
  explicitly: a tape measurement can only be recorded as part of a weigh-in.
  Tape-only entries are not possible.
- **Waist-to-hip ratio is NOT included.** Computable once waist and hip exist,
  and it would belong in `bodyComposition.ts` beside BMI, but it was not asked
  for and is not being smuggled in.

## Safety property established before starting

The vision schema lives in `ai.BodyCompositionReading` (`api/internal/ai/types.go`),
separate from both the storage struct and the mobile catalogue. Adding tape
columns therefore CANNOT touch #314's `Required + Nullable` decision. A scale
screenshot must never be asked for a tape measurement.

## T1 — Go

- Migration pair: six nullable `double precision` columns on `weight_entries`
  (`neck_cm`, `chest_cm`, `waist_cm`, `hip_cm`, `arm_cm`, `thigh_cm`).
- `BodyComposition` gains six `*float64` fields, json-tagged to the column
  names, `omitempty` so absent stays absent.
- `validateComposition` bounds them: positive, exclusive-min, max 300cm.
- Extend the existing wire test for absent-is-not-zero rather than adding a
  parallel one.

## T2 — Mobile

- Six new `CompositionMetricKey`s.
- New `CompositionUnitKind: "length"` → "cm" / "in". Add the `cm → in`
  direction beside the existing `CM_PER_IN`.
- Six entries appended to the END of `COMPOSITION_METRICS`, after the scale
  metrics — that catalogue's ordering comment says the order is a Renpho
  screenshot read top to bottom, and a tape measurement is not on it. They
  land in `OTHER_METRICS` and so render inside the existing "More fields"
  disclosure, never intruding on the two-tap weigh-in.
- The trend picker derives chips from the same catalogue, so the six series
  appear there without further work.

## Constraints

- Mutation-check every new test; report concretely.
- Repo is PUBLIC: no real measurement values anywhere.
- Never run prettier.
- Do not poll CI.
