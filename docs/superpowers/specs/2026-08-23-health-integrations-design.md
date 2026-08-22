# Health integrations — design

**Issue:** kora#30. **Milestone:** R4 – Body composition.
**Status:** approved design, not yet planned or implemented.

## Problem

Kora's dashboard shows steps, sleep and exercise that have no source. `apps/mobile/src/health/` reads steps and sleep live from HealthKit on the device, stores nothing, and never touches weight. There is no backend sync of any kind, and `weight_entries.source` has reserved a `healthkit` value since migration `000039` that nothing writes.

## Decisions

Each of these was chosen deliberately; the alternatives are recorded so a later reader can tell a decision from an accident.

| Decision | Chosen | Alternative rejected |
|---|---|---|
| Where data lives | Server-side storage for all metrics | Device-only reads, with weight the only thing persisted |
| Platform | iOS / HealthKit now; Health Connect filed separately | Building both adapters now |
| Weight conflicts | Keep both readings, separated by `source` | One weigh-in per day with a precedence rule |
| Sync cadence | Foreground only, on launch and on return from background | `HKObserverQuery` background delivery |
| Metric scope | All six: weight, steps, active energy, heart rate, sleep, workouts | Only the three the acceptance criterion names |
| Storage shape | Hybrid — generic table for interval metrics, dedicated table for workouts, weight stays in `weight_entries` | One generic table for everything; or a table per metric |

**On Google Fit.** The issue title names it, but its APIs are being retired in favour of Health Connect. Android work is tracked separately and should target Health Connect; it is out of scope here because Android has no prebuild, no health dependency, and does not ship — a Health Connect adapter written now could not be run or reviewed by anyone.

**On background delivery.** Deferred rather than dismissed. The anchor and dedup design below is the same either way, so adding `HKObserverQuery` later is an addition, not a rewrite. It is deferred because it cannot be verified in this setup at all and because its consumer, dynamic calorie targets (#39), is not being built.

## Non-goals

- Writing Kora's data back into HealthKit. This is a read integration; there is no echo loop to design around.
- Health Connect / Android.
- Dynamic calorie targets (#39). This is their foundation, not their delivery.
- Retention or downsampling policy for stored samples. Called out as a risk below.

## The constraint that shapes the schema

**Reconcile on the device; store the answer, never the raw claims.**

HealthKit returns every writing source's samples with no deduplication — iPhone, Apple Watch, and any third-party app. Two bugs in this repo already came from ignoring that:

- **#140 (steps):** raw sample sums disagreed with the Health app until steps moved to `HKStatisticsQuery`, which is the only thing that applies HealthKit's source-priority dedup.
- **#327 (sleep):** raw sample sums showed 12.8h for a normal night, because `asleepUnspecified` from one source covers the same wall-clock minutes that another source describes as Core/Deep/REM. Fixed by interval union.

Both fixes live on the device because HealthKit's dedup is only available there. Uploading raw samples and reconciling server-side would mean reimplementing Apple's source-priority logic from scratch, with less information — and would rebuild the 12.8h bug in the database, where it is harder to see.

### Two dedup strategies follow from it

`hk_uuid` is the natural dedup key, but it only exists for discrete records. A statistics query and an interval union both return an aggregate, not a sample.

- **Aggregated per day** — steps, active energy, sleep, heart rate. One row per `(user_id, metric, local_date)`, upserted. The device computes the reconciled value and pushes it; a re-sync overwrites in place. This also keeps high-frequency heart-rate samples out of the database entirely: a daily figure, not thousands of rows.
- **Discrete records** — weight and workouts. One row per HealthKit sample, deduped on `(user_id, hk_uuid)`. These are individually meaningful events, and each carries a stable UUID.

## Storage

### `health_samples` (new)

`user_id`, `metric`, `value`, `unit`, `started_at`, `ended_at`, `local_date`, `source_name`, `hk_uuid` (nullable), `platform`, `created_at`.

- `CHECK` constraint on `metric` — `steps`, `active_energy`, `heart_rate`, `sleep` — mirroring the Go constants, the way `000039` mirrors `tracking.Sources`. Changing one side alone makes the constraint reject a write the Go layer accepted.
- Unique on `(user_id, metric, local_date)`. Upsert on conflict.
- `hk_uuid` is nullable here because aggregated values have none. It exists so a future per-sample metric can share the table.

### `health_workouts` (new)

`user_id`, `activity_type`, `started_at`, `ended_at`, `duration_s`, `active_energy_kcal`, `distance_m`, `local_date`, `source_name`, `hk_uuid`, `platform`, `created_at`. Unique on `(user_id, hk_uuid)`.

Separate from `health_samples` because a workout is a structured session, not a number over a span. Forcing it into a `value` column means either losing its structure or spilling it into JSON.

### `weight_entries` (extended)

HealthKit weights become ordinary rows with `source = 'healthkit'`, reusing the provenance and per-instrument trend work R4 built. One addition: a nullable `hk_uuid` column with a **partial** unique index (`WHERE hk_uuid IS NOT NULL`), so a re-sync cannot insert the same Withings reading twice while manual and screenshot rows — which have no UUID — remain unconstrained.

This is what makes "keep both readings, separated by source" work with no second code path: a HealthKit weight is a weight entry like any other, and the chart already refuses to join incomparable instruments.

`local_date` on every table follows kora#84: fixed at write time in the device's zone, never derived later.

## Sync flow

On launch, and on return from background:

1. For each metric, read the device-persisted anchor.
2. Run an anchored query from that anchor.
3. Reconcile **on the device** — `HKStatisticsQuery` for quantity types, interval union for sleep, raw records for weight and workouts.
4. `POST /v1/health/sync` as one batch.
5. Advance the anchor **only on success**.

**The anchor lives on the device.** `HKAnchoredObjectQuery` returns an opaque cursor meaningful only to that device's HealthKit store. Persisting it server-side would break the moment the user signs in on a second phone: the second device would resume from a cursor that means nothing to it and silently skip data.

**Partial failure leaves the anchor unmoved.** The next launch re-sends the same window, and the dedup keys make that harmless. This is why idempotency is load-bearing rather than defensive — the retry path is the normal path.

## Error handling

- **Permission denied or not granted.** Say so; do not present an empty dashboard as though the user has no data. The existing `useHealth` status model already draws this distinction and should be reused, not reinvented.
- **Sync failure.** Fails quietly and retries next launch. A failed background-ish sync is not worth a modal.
- **Partial batch rejection.** The endpoint validates per record and reports which were rejected; accepted records commit. A single malformed sample must not discard a good batch.
- **Server-side validation.** Same posture as `internal/bodyread`: implausible values are dropped and reported, not clamped, and never silently accepted. An unknown `metric` value is rejected at the boundary rather than reaching the CHECK constraint.

## Privacy

Kora's server holds no health telemetry today. This change creates that obligation, so both parts ship with it rather than after:

- **Export (#24)** must include `health_samples` and `health_workouts`.
- **Account deletion** must cascade both. Kora's account deletion has been broken twice by identities living in a different GCP project from the rest of the data; whatever path this hooks must be the one the rest of the app uses.

## Testing

- **Pure functions first.** The reconciliation (interval union already exists from #327; statistics-query handling; aggregate-per-day bucketing) is where the logic lives and the only part testable without a device. Drive it with synthetic multi-source samples.
- **Idempotency.** Syncing the same batch twice produces the same rows. This is the property the whole design rests on.
- **Dedup keys.** An upsert on `(user_id, metric, local_date)` overwrites; a duplicate `hk_uuid` is rejected; a null `hk_uuid` does not collide with another null.
- **Weight provenance.** A HealthKit weight and a manual weight on the same day both persist and do not join in a trend.
- **Mutation-check every new test.**

### What cannot be verified here

**HealthKit reads never succeed on a simulator (#187).** Nothing in this design can be verified end to end in this setup. Unit tests on the reconciliation and the sync endpoint are the real coverage; anything claiming otherwise is wrong.

Device verification against the Health app's own figures — the standard #140 applied to steps and #327 still owes for sleep — remains outstanding for every metric here, and is best done on a device with **more than one** source writing, since that is the case that produces the bugs.

## Risks

- **Scope.** Six metrics across two new tables and an endpoint is the largest single slice in R4. It is worth splitting at implementation-planning time — weight and steps first, since they have consumers today — rather than landing as one change.
- **No consumer yet.** Heart rate and workouts have no reader in the app. They are being stored because #30 lists them, not because anything displays them. That is a real argument for deferring them, and it is recorded here so the choice stays visible.
- **Retention is undefined.** Daily aggregates are small, but workouts and weights accumulate indefinitely with no policy. Not designed here; should be decided before the closed beta puts real users behind it.
- **`local_date` and travel.** A day's aggregate is computed on the device in its current zone. Crossing zones mid-day makes "today" ambiguous; kora#84's convention is followed, but the aggregate case is new and untested against it.

## References

kora#30, #24, #39, #84, #140, #187, #327, #367, migration `000039`.
