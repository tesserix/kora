---
quick_id: 260823-ivt
slug: fix-375-healthkit-launch-prompt
issue: 375
date: 2026-08-23
---

# Quick Task: HealthKit permission must not be requested on app launch (#375)

## Problem

`useHealthSync` is mounted at the app root (`app/_layout.tsx:114`). Its
`queryWeights` calls `requestAuthorization({ toRead: [BODY_MASS] })`
unconditionally, so every user gets the iOS Health permission sheet on first
launch after this ships — before anything explains why. A read denial is
sticky (Settings-only reversal), so a badly timed prompt can lose the feature
permanently.

## Approach (option 1 from the issue — user-confirmed)

The library exposes `getRequestStatusForAuthorization({ toRead })`, returning
`AuthorizationRequestStatus.shouldRequest | unnecessary | unknown`. That is the
only iOS-sanctioned way to ask "has the user been prompted yet" — read
authorization status itself is deliberately hidden by Apple, so `unnecessary`
means *asked*, not *granted*. That distinction is exactly what this fix needs:
the gate is "never prompt from a background path", not "know if we may read".

1. New module `src/health/weightPermission.ts`:
   - `weightPermissionRequested(): Promise<boolean>` — true only when the
     status is `unnecessary`. `unknown` (HealthKit unreachable) → false.
   - `requestWeightPermission(): Promise<void>` — the actual prompt.
   Both use the same lazy `require` pattern as `useHealthSync.ts` /
   `useHealth.ts` (Nitro module throws at *import* time when unlinked).
2. `useHealthSync.queryWeights`: replace the `requestAuthorization` call with
   `weightPermissionRequested()`; throw when false. Throwing (not returning an
   empty batch) preserves the existing self-healing property — `syncWeight`
   only advances the anchor after a successful query, so a skipped launch
   retries next foreground, unchanged.
3. `LogWeightSheet`: on iOS, when the sheet becomes visible, call
   `requestWeightPermission()`. iOS shows the sheet at most once, so an
   already-determined state is a silent no-op. This is the point of use — the
   user has just opened "Log weight".

## Tasks

- **T1** — `src/health/weightPermission.ts` + tests. Mock the healthkit module;
  cover `unnecessary` → true, `shouldRequest` → false, `unknown` → false, and
  the module-unavailable throw.
- **T2** — Rewire `useHealthSync.queryWeights` to the gate. Test: with status
  `shouldRequest`, `requestAuthorization` is NEVER called and the anchor is not
  advanced; with `unnecessary`, the query runs as before.
- **T3** — `LogWeightSheet` requests permission on open (iOS only), non-iOS is
  a no-op, and a rejected request never surfaces an error to the user (the
  sheet must still work for manual logging without Health).

## Acceptance (from #375)

- Fresh install shows no Health permission sheet on launch
- The prompt appears where the user can tell what it is for
- Sync still runs on launch/foreground once permission has been requested

## Constraints

- Every new test must be mutation-checked and reported concretely.
- `apps/mobile` is Expo SDK 57 — check the versioned docs before API changes.
- No device verification is possible; HealthKit reads never succeed on a
  simulator (#187). Do not claim device behaviour.
- Repo is public: no real weight values in code, tests, or commits.
