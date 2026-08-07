# HealthKit usage — App Review note

Kora reads a small set of HealthKit data to show the user their own activity alongside the food they log, and to help tailor onboarding. Kora never writes to HealthKit — every HealthKit call requests read-only (`toRead`) authorization, with no `toShare`/write types and no save calls anywhere in the app.

- **Step count** (`HKQuantityTypeIdentifierStepCount`) — read on the Home dashboard and the Progress tab to display today's steps, and read over a recent window during onboarding to help infer the user's activity level.
- **Sleep analysis** (`HKCategoryTypeIdentifierSleepAnalysis`) — read on the Home dashboard to display last night's sleep.
- **Workouts** (`HKWorkoutTypeIdentifier`) — read during onboarding, alongside step history, to help infer the user's activity level.

The user sees this data as read-only summaries: a steps/sleep card on the Home tab, a steps metric on the Progress tab, and an activity-level suggestion during onboarding. Authorization is requested via the standard HealthKit permission prompt (`NSHealthShareUsageDescription`), and if the user declines, Kora falls back gracefully (the affected UI simply shows no HealthKit data). Kora does not request or use the clinical health records entitlement, and does not write, update, or delete any HealthKit samples.
