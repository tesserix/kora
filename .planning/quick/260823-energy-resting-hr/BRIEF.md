# #372 — active energy + resting heart rate

Agreed design. Do not re-decide these.

## Why the scope is this small

#372 as written says "sync steps, energy, sleep and heart rate" and claims a
design doc exists. The doc does not exist, and **steps, sleep and workouts
already sync** via `apps/mobile/src/mentor/healthSync.ts` →
`PUT /v1/mentor/health/days` → `health_daily_summaries`, consumed by the coach
through `mentor.HealthDay`. Only two metrics are genuinely missing.

Decision: **two more columns on the existing daily table.** No `health_samples`
table. Nothing needs intraday resolution, and the coach's context is day-shaped.

**Resting** heart rate, not heart rate. `HKQuantityTypeIdentifierRestingHeartRate`
is its own HealthKit type and is the figure that tracks fitness and recovery; a
daily average of all-day heart rate is close to meaningless. This is what
removed the need for discrete samples.

## Schema (migration 000051)

On `health_daily_summaries`:
- `active_energy_kcal INTEGER` — CHECK NULL OR >= 0
- `resting_heart_rate_bpm INTEGER` — CHECK NULL OR BETWEEN 20 AND 250
  (outside that range it is not a human at rest)

On `mentor_profiles` (see 000040 line 12 for the existing pattern):
- `health_energy_enabled BOOLEAN NOT NULL DEFAULT FALSE`
- `health_heart_rate_enabled BOOLEAN NOT NULL DEFAULT FALSE`

Consent is opt-in, matching the three flags already there.

## Go

- Both fields on `mentor.HealthDay` and the profile (model, service, repository).
- `filterHealthByConsent` (`coach/grounding.go`) nils each when its flag is off.
  That function is the SINGLE consent gate — a metric missed there reaches the
  coach after the user withdrew permission.

## Mobile

- `healthSync.ts`: read `HKQuantityTypeIdentifierActiveEnergyBurned` **summed**
  per local day, and `HKQuantityTypeIdentifierRestingHeartRate` **averaged** per
  local day, rounded. Both consent-gated exactly like steps.
  - Ruling: mean, not latest. HealthKit usually emits one resting-HR value per
    day so they mostly agree; where they differ a mean is stable and "latest"
    would swing on sample ordering.
- `mentor.tsx`: two more `HealthToggle`s (see lines 384-386 for the pattern).
- **`mentor.tsx:161` — the revocation check.** Turning a toggle OFF triggers
  cleanup. Both new flags MUST join that condition, or withdrawing consent
  leaves energy / heart-rate data behind. That is a privacy bug and it ships
  green if missed.

## Constraints

- Repo is PUBLIC: no real health values in code, tests, fixtures or commits.
- Never run prettier.
- Mutation-check every new test.
- Do not poll CI.
- Single-line conventional commits, no signatures, reference `(#372)`.
