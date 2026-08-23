# #372 — active energy + resting heart rate — Go side report

## Status: complete

Commit: `fa46c3a1` — `feat(mentor): sync active energy and resting heart rate into health_daily_summaries (#372)`

Single commit, all three scope items landed together (migration + mentor package + coach consent gate + tests).

## What was built

### 1. Migration 000051

`api/internal/database/migrations/000051_health_energy_resting_hr.up.sql` / `.down.sql`

- `health_daily_summaries.active_energy_kcal INTEGER` — `CHECK (active_energy_kcal IS NULL OR active_energy_kcal >= 0)`
- `health_daily_summaries.resting_heart_rate_bpm INTEGER` — `CHECK (resting_heart_rate_bpm IS NULL OR resting_heart_rate_bpm BETWEEN 20 AND 250)`
- `mentor_profiles.health_energy_enabled BOOLEAN NOT NULL DEFAULT FALSE`
- `mentor_profiles.health_heart_rate_enabled BOOLEAN NOT NULL DEFAULT FALSE`

**Deviation beyond the brief's literal schema section (Rule 2 — missing critical functionality):** the existing `health_daily_summaries_has_metric_check` constraint requires at least one of `steps` / `sleep_minutes` / `workout_minutes` to be non-null. Left as-is, a day synced with *only* active energy or *only* resting heart rate (a real HealthKit scenario — e.g. a user who wears an Apple Watch but logs no workouts) would be silently rejected at insert time, and the service-level "at least one measured value" validation in `PutHealthDays` would reject it even earlier. I widened both:
- the DB check to `steps IS NOT NULL OR sleep_minutes IS NOT NULL OR workout_minutes IS NOT NULL OR active_energy_kcal IS NOT NULL OR resting_heart_rate_bpm IS NOT NULL`
- the service validation in `PutHealthDays` to match

This isn't a re-decision of the brief's schema — it's the pre-existing has-at-least-one-metric guard, which the brief didn't mention updating but which would otherwise silently break ingestion of energy-only/heart-rate-only days. Verified via mutation test (see below).

Migration tested: applied via `go run ./cmd/migrate` against the real dev DB, verified column/constraint shapes with `psql \d`, then rolled back one step with `migrate down 1` (clean, no errors) and re-applied with `migrate up 1` to restore state. Down migration is a full mirror of up (drops constraints/columns in reverse order).

### 2. `mentor` package

- `HealthDay.ActiveEnergyKcal *int`, `HealthDay.RestingHeartRateBpm *int` (model.go)
- `Profile.HealthEnergyEnabled bool`, `Profile.HealthHeartRateEnabled bool` (model.go)
- `ProfileInput` / `HealthDayInput` in service.go carry the same two new fields each, mirroring the steps/sleep/workout pattern exactly
- `PutProfile` threads the two new consent flags through to the persisted `Profile`
- `PutHealthDays` validates: `active_energy_kcal >= 0`, `resting_heart_rate_bpm` in `[20, 250]` (via the existing `optionalRange` helper), and both fields count toward the "at least one measured value" check (see deviation above)
- `Repository.UpsertProfile` / `UpsertHealthDays` — both new columns added to the `clause.OnConflict` `DoUpdates` column lists so upserts actually persist them (GORM `Find`/`Create` pick the new struct fields up automatically via tags, no other repository change needed)

### 3. `coach/grounding.go` — the consent gate

`filterHealthByConsent` now nils `ActiveEnergyKcal` when `!HealthEnergyEnabled` and `RestingHeartRateBpm` when `!HealthHeartRateEnabled`, matching the existing per-metric pattern exactly.

**Deviation not explicitly listed in the brief but necessary for the feature to work at all (Rule 1/2):** one level above `filterHealthByConsent`, `mentorContext` has a gate that decides whether to fetch health days from the DB *at all*:

```go
if profile != nil && (profile.HealthStepsEnabled || profile.HealthSleepEnabled || profile.HealthWorkoutsEnabled) {
```

Left unmodified, a user who consents *only* to active energy or *only* to resting heart rate would never have health days fetched — `filterHealthByConsent` would never even run for them, and their consented data would never reach the coach. I extracted this into a small pure function `anyHealthConsented(profile mentor.Profile) bool` that includes all five flags, used both at the fetch gate and unit-tested directly. This is the same "single consent gate" principle the brief calls out for `filterHealthByConsent`, one level higher in the same call path — without it, the brief's stated goal ("nils each new metric when its flag is off") is unreachable for energy/heart-rate-only consent.

I did **not** extend `Render()`/`Facts()` (the prose/citable-fact builders further down in grounding.go) to surface the two new metrics in the coach's actual output text — that's a product/copy decision (what to say, what label to use) not covered by the brief's three listed Go scope items, and the brief's "matters most" section calls out `filterHealthByConsent` specifically, not the rendering layer. The data now flows correctly through `HealthDay` → consent filter → `Context.HealthDays`, but nothing in the prompt currently reads `ActiveEnergyKcal`/`RestingHeartRateBpm` off `HealthDay` in `Render`/`Facts`. Flagging this so it's a deliberate scope call, not an oversight — if the coach is expected to actually mention active energy / resting heart rate in its replies, that's a follow-up.

## Tests added

1. `api/internal/coach/grounding_consent_test.go`
   - `TestFilterHealthByConsentNilsEveryMetricWhenItsFlagIsOff` — asserts all 5 metrics nil out when their flag is off, survive when on, and that energy-only / heart-rate-only consent correctly isolates just that metric without leaking the others.
   - `TestAnyHealthConsentedIncludesEveryFlag` — table test over all 5 flags in isolation, guards the fetch gate described above.

2. `api/internal/database/migrations_energy_resting_hr_test.go` (mirrors `migrations_tape_measurements_test.go` pattern)
   - `TestHealthEnergyAndRestingHeartRateColumnsAreNullableIntegers`
   - `TestRestingHeartRateCheckConstraintRejectsOutOfRangeValues`
   - `TestActiveEnergyCheckConstraintRejectsNegativeValues`
   - `TestMentorProfileHealthConsentFlagsDefaultToOptedOut`
   - `TestHasMetricCheckAllowsEnergyOrHeartRateAlone`

## Mutation checks (all as required — concrete, reported, restored)

1. **Removed** `if !profile.HealthEnergyEnabled { out[i].ActiveEnergyKcal = nil }` from `filterHealthByConsent`.
   → `TestFilterHealthByConsentNilsEveryMetricWhenItsFlagIsOff` FAILED: `Expected nil, but got: (*int)(0x...)` / `"active_energy_kcal must be nil when health_energy_enabled is off"` (2 assertion failures, all-off case and energy-only case).
   → Restored, re-ran, GREEN.

2. **Removed** the `HealthHeartRateEnabled` nil-out block from `filterHealthByConsent`.
   → Same test FAILED: `"resting_heart_rate_bpm must be nil when health_heart_rate_enabled is off"` (2 assertion failures).
   → Restored, re-ran, GREEN.

3. **Removed** `profile.HealthEnergyEnabled ||` from `anyHealthConsented`.
   → `TestAnyHealthConsentedIncludesEveryFlag/energy_only` FAILED: `expected: true / actual: false`.
   → Restored, re-ran, GREEN.

4. **Widened** the live DB `health_daily_summaries_resting_heart_rate_check` constraint (dropped/re-added via `psql` with range `0 AND 999` instead of `20 AND 250`).
   → `TestRestingHeartRateCheckConstraintRejectsOutOfRangeValues` FAILED: `"...>= 0)) AND (...<= 999)))" does not contain "20"`.
   → Restored the real constraint, re-ran, GREEN.

5. **Narrowed** the live DB `health_daily_summaries_has_metric_check` back to the pre-migration definition (steps/sleep/workout only, dropping energy/heart-rate from the OR).
   → `TestHasMetricCheckAllowsEnergyOrHeartRateAlone` FAILED: `"...workout_minutes IS NOT NULL)))" does not contain "active_energy_kcal"`.
   → Restored the widened constraint, re-ran, GREEN.

No mutation stayed green — nothing to report as a weak/no-op test.

## Build / vet / test output

```
$ go build ./...
(no output — success)

$ go vet ./...
(no output — success)

$ TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable \
  go test -count=1 ./internal/mentor/... ./internal/coach/... ./internal/database/...
ok  	github.com/tesserix/kora/api/internal/mentor	0.823s
ok  	github.com/tesserix/kora/api/internal/coach	2.171s
ok  	github.com/tesserix/kora/api/internal/database	0.820s
```

## Environment note (worth recording — matches an existing memory entry)

`localhost:5432` on this machine has **two** postgres servers competing for the port: a native Homebrew `postgres` process (the real `kora` dev DB, role `kora`/`kora_dev`) and a Docker container `dev-postgres-1` (an unrelated marketplace project, role `dev`, no `kora` role/database at all). `lsof -nP -iTCP:5432 -sTCP:LISTEN` showed both bound simultaneously; the native process is the one that actually answers `localhost` connections with the `kora` role. Also, there is no local `psql` on `PATH` — used `/opt/homebrew/opt/postgresql/bin/psql` directly. `TEST_DATABASE_URL` was not pre-set in the shell; had to export it explicitly for both `go run ./cmd/migrate` and `go test`.

## Repo-public safety

No real health values used anywhere — all test/mutation values are round, obviously synthetic numbers (5000 steps, 420 min sleep, 300 kcal, 60 bpm, etc.), consistent with the existing `migrations_tape_measurements_test.go` style.

## Not touched (out of scope per instructions)

- Nothing under `apps/` (mobile side — `healthSync.ts`, `mentor.tsx`, the toggle UI, the revocation-check condition at `mentor.tsx:161`) was touched. That's the second agent's job per the brief.
- `Render()` / `Facts()` in `coach/grounding.go` were not extended to surface the two new metrics in coach prose/citations — see deviation note above.

## No factual errors found in the brief

The brief's premises (steps/sleep/workouts already sync, resting-HR-not-HR distinction, day-shaped table decision, 000040 pattern reference) all checked out against the actual code.
