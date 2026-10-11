# #372 — active energy + resting heart rate: mobile report

## Scope

Mobile-only. Go side already shipped in `fa46c3a1`; contract confirmed via `git show fa46c3a1`:

- `mentor.HealthDay` gained `active_energy_kcal *int` (json `active_energy_kcal`) and
  `resting_heart_rate_bpm *int` (json `resting_heart_rate_bpm`).
- `mentor.Profile` gained `HealthEnergyEnabled bool` (json `health_energy_enabled`) and
  `HealthHeartRateEnabled bool` (json `health_heart_rate_enabled`).

## Files changed

- `apps/mobile/src/mentor/healthSync.ts`
- `apps/mobile/src/api/types.ts`
- `apps/mobile/src/mentor/useMentorRuntime.ts`
- `apps/mobile/app/mentor.tsx`
- Tests: `apps/mobile/src/mentor/__tests__/healthSync.test.ts`,
  `apps/mobile/src/mentor/__tests__/useMentorRuntime.test.tsx`,
  `apps/mobile/app/__tests__/mentor.test.tsx`,
  `apps/mobile/src/api/__tests__/mentorHooks.test.tsx`

## Implementation

### healthSync.ts

- `MentorHealthConsent` extended with `energy: boolean` and `heartRate: boolean`.
- Added `HKQuantityTypeIdentifierActiveEnergyBurned` (unit `kcal`) and
  `HKQuantityTypeIdentifierRestingHeartRate` (unit `count/min`), both read via
  `queryStatisticsCollectionForQuantity` bucketed per local day — the same call shape
  already used for steps.
  - Active energy uses `cumulativeSum` (summed per day, same statistics option as
    steps), rounded.
  - Resting heart rate uses `discreteAverage` (HealthKit computes the mean of that
    day's bucket directly — this is the "mean, not latest" ruling from the brief),
    rounded.
- Both are consent-gated identically to `consent.steps`: absent from `toRead` and
  never queried when the corresponding flag is off (covered by a dedicated test,
  see below).
- `addMetric`'s metric-shape type was widened to include the two new
  `MentorHealthDayInput` fields; no other structural changes.

### types.ts

- `MentorProfileInput` gained `health_energy_enabled: boolean` and
  `health_heart_rate_enabled: boolean`, mirroring the existing three.
- `MentorHealthDayInput` gained `active_energy_kcal?: number | null` and
  `resting_heart_rate_bpm?: number | null`, mirroring `steps` / `sleep_minutes`.

### useMentorRuntime.ts

- `consent` object built for `collectMentorHealthDays` now includes `energy` and
  `heartRate`, sourced from `data.health_energy_enabled` /
  `data.health_heart_rate_enabled`.
- The "any consent enabled" short-circuit and the `consentKey` cache-busting string
  (used to gate the 15-minute resync interval) both extended to include the two new
  flags — a user who only enables active energy now correctly triggers a sync, and
  changing only that flag invalidates the interval cache.

### mentor.tsx

- `EMPTY_PROFILE` and `inputFromProfile` extended with the two new fields.
- Two new `HealthToggle`s added below "Share workouts": "Share active energy"
  (testID `mentor-health-energy`) and "Share resting heart rate" (testID
  `mentor-health-heart-rate`), following the exact existing pattern.
- **The revocation check at `save()` (originally line 161, now ~164–169)**: both new
  flags added as additional OR clauses:
  ```
  || (previous.health_energy_enabled && !draft.health_energy_enabled)
  || (previous.health_heart_rate_enabled && !draft.health_heart_rate_enabled)
  ```
  Turning either toggle off now correctly triggers `pauseMentorHealthSync()` +
  `deleteHealth.mutateAsync()`, same as steps/sleep/workouts.

## Tests added

1. `healthSync.test.ts`
   - "active energy is summed per day and resting heart rate is averaged per day" —
     asserts `toRead` includes both new identifiers when consented, and that a
     483.6-kcal bucket rounds to 484 / a 57.5-bpm average rounds to 58.
   - "active energy and resting heart rate are not queried without consent" —
     asserts `toRead` excludes both identifiers and neither field appears on the
     output day when their consent flags are false.

2. `useMentorRuntime.test.tsx`
   - Updated the existing consent-shape assertion to include `energy: false,
     heartRate: false`.
   - Added "confirmed Health consent syncs when only active-energy or
     resting-heart-rate is enabled" — proves the sync fires and the consent object
     passed to `collectMentorHealthDays` is correct when steps/sleep/workouts are
     all off and only the two new flags are on.

3. `app/__tests__/mentor.test.tsx` — **the privacy-critical tests**:
   - "revoking active-energy consent alone still deletes uploaded summaries" —
     toggles `mentor-health-energy` off (with only that flag previously true) and
     asserts `mockDeleteHealth` is called.
   - "revoking resting-heart-rate consent alone still deletes uploaded summaries" —
     same, for `mentor-health-heart-rate`.
   - These two tests are constructed so each fails on its own if its corresponding
     clause is missing from the revocation `||` chain in `save()`, independent of
     the other flags.

4. `mentorHooks.test.tsx` — extended a `mutateAsync` call's input object with the two
   new fields so it still type-checks against `MentorProfileInput`. No new behavior
   under test there.

## Mutation checks (each reported concretely)

1. **The privacy-critical check.** Removed
   `|| (previous.health_energy_enabled && !draft.health_energy_enabled)` from
   `mentor.tsx`'s revocation condition → ran
   `revoking active-energy consent alone still deletes uploaded summaries` →
   **RED** (`mockDeleteHealth` called 0 times, expected 1). Restored, re-ran full
   `mentor.test.tsx` → green, file diffed byte-identical to pre-mutation state.
2. Same for the resting-heart-rate clause → ran
   `revoking resting-heart-rate consent alone still deletes uploaded summaries` →
   **RED** (same failure mode). Restored, re-verified green.
3. Removed `Math.round(...)` from the active-energy aggregation in `healthSync.ts`
   (`{ active_energy_kcal: value }` instead of `Math.round(value)`) → ran
   `active energy is summed per day and resting heart rate is averaged per day` →
   **RED** (`483.6` received instead of expected `484`, plus a spurious
   `toEqual` structural mismatch from `objectContaining` vs the raw value —
   confirms the rounding assertion is load-bearing). Restored, re-verified green.

No mutation stayed green. All three checks above are reported in full, per the
verification-honesty requirement — none were hidden.

## Verification honesty

- `npx tsc --noEmit` in `apps/mobile`: **clean, no output.**
- `npx eslint` on all 8 touched files: **clean, no output.**
- Full mobile jest suite: **242 suites / 2328 tests passed**, 0 failures. (One
  benign Jest worker warning about a leaking timer on shutdown — pre-existing
  behavior unrelated to this change, not investigated further per scope boundary.)
- jest performs **no layout**. The `HealthToggle` tests (and the two new
  revocation tests) prove the two new toggles are present in the render tree, wired
  to the correct testIDs, and that firing `valueChange` on them updates `draft`
  correctly and reaches `save()`'s revocation logic. They do **not** prove the
  toggles are reachable/visible/scrollable on a real device screen that now has two
  more rows — no visual or on-device verification was performed or is claimed.
- No real health values were used anywhere (kcal example: 483.6→484;
  bpm example: 57.5→58 — both synthetic).
- Did not touch `api/` per instructions. Did not run prettier. Did not poll CI.

## No factual errors found in the brief

The field names, HealthKit identifiers, aggregation rules (sum for energy, mean for
heart rate), and the exact toggle/revocation locations all matched what `git show
fa46c3a1` and the current `mentor.tsx` / `healthSync.ts` showed. Nothing required
stopping to report a discrepancy.

## Commit

`96251037` — `feat(mentor): sync active energy and resting heart rate on mobile (#372)`
