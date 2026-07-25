# Kora — Weight Tracking (Design)

**Date:** 2026-07-25
**Branch base:** `phase-2-nutrition-engine` (current tip)
**Fidelity ref:** `design-system/ui_kits/kora/ProgressScreen.jsx` (weight card + area/line chart + range toggle).

## Problem

The Progress screen's weight chart is **fake**: `apps/mobile/app/(tabs)/progress.tsx` hardcodes `WEIGHTS`/`LABELS` sample arrays and a static "1.8 kg" trending-down badge (comment: "Placeholder sample series — weight tracking is a later phase"). The user model already stores an onboarding `weight_kg`, but there is no time-series of weight and no way to log it. This makes weight tracking real.

## Scope

**In scope**
1. Backend: a `weight_entries` time series + log/list endpoints (mirrors the existing `water` code in `internal/tracking`).
2. Mobile: log weight via a sheet on Progress; Progress reads real data (chart, current weight, delta, functional range toggle); seed the first-run view from the onboarding weight.

**Out of scope** (deferred — noted so the plan doesn't drift)
- Steps / sleep on Progress (separate data sources; stay static for now).
- lb units (kg only — metric, AU-first, matches the user model + existing UI).
- Editing/deleting a past weight entry (add-only for v1).
- Weight logging from Home.
- Backfilling a real `weight_entries` row from onboarding (seeding is display-side only — see §Seed rule).

## Backend

Add to the existing `internal/tracking` package (do not create a new package — weight is a peer of water).

### Migration `000008_weight_entries`
`weight_entries`: `id uuid pk default gen_random_uuid()`, `user_id uuid not null`, `weight_kg double precision not null`, `logged_at timestamptz not null`, `created_at timestamptz not null default now()`. Index `idx_weight_entries_user_logged (user_id, logged_at)`. Down migration drops the index then the table. Reversible.

### Model / repository
- `tracking.WeightEntry` (GORM): `ID`, `UserID uuid.UUID json:"-"`, `WeightKg float64 json:"weight_kg"`, `LoggedAt time.Time json:"logged_at"`, `CreatedAt time.Time json:"created_at"` — mirrors `WaterEntry`.
- `Repository.AddWeight(ctx, userID, weightKg float64, at time.Time) (WeightEntry, error)`: validates `weightKg > 0` (→ `httpx.ValidationError`); defaults `LoggedAt` to now when `at` is zero; inserts.
- `Repository.WeightSeries(ctx, userID, from, to time.Time) ([]WeightEntry, error)`: `WHERE user_id = ? AND logged_at >= ? AND logged_at < ?`, `ORDER BY logged_at ASC`.

### Handlers / routes (both behind the `v1` GIP-auth group, resolve userID from context like the water handlers)
- `POST /v1/weight` — body `{ weight_kg: number, logged_at?: string(RFC3339) }`. Validation error → 400 via `httpx`; success → 201 `{data: entry}`.
- `GET /v1/weight?from=<RFC3339>&to=<RFC3339>` — returns `200 {data: [entries ASC]}`. If `from`/`to` are absent or unparyable, default `to = now`, `from = now - 365d` (so a bare call returns the last year).
- Mount on the existing `trackingHandler` in `internal/server/router.go` next to `/water`.

## Mobile

### Types + hooks
- `WeightEntry` type in `src/api/types.ts`: `{ id: string; weight_kg: number; logged_at: string }`.
- `useAddWeight()` in `src/api/hooks.ts`: `mutationFn({ weight_kg, logged_at? })` → `apiFetch("/v1/weight", { method: "POST", body })`; `onSuccess` → invalidate `["weight"]`.
- `useWeightSeries(range: "1W" | "1M" | "3M" | "1Y")`: `useQuery`, `queryKey ["weight", range]`, `queryFn` computes `from`/`to` from the range (`to = now`, `from = now − {7d, 30d, 90d, 365d}`) and GETs `/v1/weight?from=&to=`. Return `WeightEntry[]`.

### Progress screen (`app/(tabs)/progress.tsx`)
Replace the placeholder `WEIGHTS`/`LABELS`/static badge with real data:
- Fetch `const entries = useWeightSeries(range)` and `const profile = useProfile()`.
- **Display series** (immutably derived, no mutation):
  - If `entries` non-empty → `points = entries.map(e => e.weight_kg)`, labels from `entries[i].logged_at` (short date; show a subset like the current LABELS cadence to avoid crowding).
  - If `entries` empty → **seed** the current-weight number from `profile.data?.weight_kg` (when > 0) and show a "Log your weight to see a trend" hint. If profile weight is also absent, show an empty state ("Log your first weight").
- **Current weight** = last entry's `weight_kg` (else `profile.weight_kg`, else "—").
- **Delta badge** = `last − first` of the displayed points: `trending-down` (success) when losing, `trending-up` when gaining, hidden when < 2 points. Text = signed kg to one decimal.
- The `1W/1M/3M/1Y` toggle now drives `useWeightSeries(range)` (refetches per range) instead of being cosmetic.
- **Chart rendering:** `WeightChart` (unchanged) computes `x(i) = ... / (points.length - 1)`, so it requires **≥2 points** (a single point divides by zero → NaN). Therefore render `<WeightChart points={points} />` **only when `points.length >= 2`**; with 0–1 points show the current-weight number + the "Log your weight to see a trend" hint and **no chart**. This keeps the seed/first-log states safe without changing WeightChart's math.

### Log-weight sheet
- Tapping the weight card (make it a `Pressable`, `accessibilityLabel="Log weight"`) opens a `Sheet` (the existing bottom-sheet component) containing: a title "Log weight", a `TextInput` (`keyboardType="decimal-pad"`) prefilled with the current weight as a string, a "kg" affix, and a **Save** button.
- Save parses the input (`parseFloat`), rejects `<= 0`/NaN with an inline message, else `useAddWeight().mutate({ weight_kg })` → on success close the sheet (the `["weight"]` invalidation refreshes the chart). Errors surface (no silent failure); Save disabled while pending.

## Testing

- **Backend** (`internal/tracking`, run against isolated `kora_test`): `AddWeight` inserts + rejects `<= 0`; `WeightSeries` returns only in-range rows ASC and is user-scoped; handler `POST /v1/weight` 201 + 400-on-bad-body, `GET` returns the series and applies default range. Migration `000008` up/down verified (manual per existing gap; do not add a shared-DB down-migration test).
- **Mobile** (`npx tsc --noEmit` + `npm test -- --ci`, RNTL v14 async): `useAddWeight` posts the right body + invalidates `["weight"]`; `useWeightSeries("1M")` GETs with a `from`/`to` ~30 days apart; Progress renders the chart (≥2 entries) when data exists and the seeded current-weight number + hint (no chart) when the range is empty; the sheet's Save calls `useAddWeight` with the parsed number and rejects a non-positive input.

## Files touched
- Backend: `api/internal/database/migrations/000008_weight_entries.{up,down}.sql`, `api/internal/tracking/model.go`, `repository.go`, `repository_test.go`, `handler.go`, `handler_test.go` (or a focused new test file), `api/internal/server/router.go`.
- Mobile: `src/api/types.ts`, `src/api/hooks.ts`, `app/(tabs)/progress.tsx`, a new `src/components/progress/WeightLogSheet.tsx` (or inline sheet), tests alongside.
