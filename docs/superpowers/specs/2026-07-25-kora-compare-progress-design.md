# Design — Compare progress (Social sub-project B)

**Date:** 2026-07-25
**Branch:** `phase-5-compare` (new, off `main` HEAD `c037dbe`)
**Type:** Full-stack feature — builds on the Friends foundation (sub-project A)

## Context

Second slice of Kora's social domain. Sub-project A (Friends) shipped the graph and shares only
`id`+`display_name`. **B is the first time one user sees another's health data**, so an explicit
consent gate is central. Metrics are habit-based (on-brand; never weight or raw calories).

Enablers already in the codebase:
- `dashboard.Service.streakDays` computes `streak_days` = consecutive days with ≥1 food log
  (`api/internal/dashboard/service.go:91`), via `foodlog.Repository.LoggedDaysDesc(ctx, userID,
  notAfter, loc, limit)` (`repository.go:97`).
- Users have `TargetKcal` (`api/internal/user/model.go`) and a `timezone`.

### Product decisions (locked during brainstorming)
- **Metrics:** `streak_days` + **goal-adherence**.
- **Adherence definition:** over the last **7 days** (in the user's timezone), the number of days
  whose total logged calories fall **within ±10% of `target_kcal`**. Shown as "N/7 on target."
  Goal-agnostic (the target encodes lose/maintain/gain). A small aggregate — never raw intake.
- **Consent:** a **global opt-in** `share_progress` flag, **default false**; each user controls
  their own visibility. Off → friends see only your name.
- **UI:** a **ranked list on the Friends screen** (leaderboard by streak) + a "Share my progress"
  toggle. Not a new tab/route.

## 1. Data model

### Migration `000010_share_progress`
- `ALTER TABLE users ADD COLUMN share_progress BOOLEAN NOT NULL DEFAULT false;`
- `.down.sql`: `ALTER TABLE users DROP COLUMN IF EXISTS share_progress;`
- No new tables — streak and adherence are computed from `food_logs` + the user's `target_kcal`.

## 2. Backend

### 2a. Progress metric helper — new `internal/progress` package
A small, reusable, testable unit (keeps the compare handler thin and avoids coupling to dashboard).

- `type Metrics struct { StreakDays int; AdherenceDays int; AdherenceWindow int }`
- `func Compute(ctx, logs LogSource, userID uuid.UUID, targetKcal float64, day time.Time, loc *time.Location) (Metrics, error)`
  where `LogSource` is a tiny interface satisfied by `foodlog.Repository`:
  - `LoggedDaysDesc(ctx, userID, notAfter, loc, limit) ([]string, error)` (exists) — for streak.
  - `DailyKcal(ctx, userID, from, to, loc) (map[string]float64, error)` (NEW on `foodlog.Repository`)
    — sums `food_logs.kcal` grouped by local day over `[from, to)`.
- **Streak:** same walk-back-from-`day` logic the dashboard uses (consecutive logged days).
- **Adherence:** for each of the last 7 local days, if `targetKcal > 0` and
  `abs(dayKcal - targetKcal) <= 0.10 * targetKcal`, count it. `AdherenceWindow = 7`.
  When `targetKcal == 0` (not onboarded), `AdherenceDays = 0`.

`DailyKcal` (new repo method): `SELECT date_trunc('day', logged_at AT TIME ZONE $tz)::date AS d,
COALESCE(SUM(kcal),0) FROM food_logs WHERE user_id=? AND logged_at >= ? AND logged_at < ? GROUP BY
d` — returns a `map[YYYY-MM-DD]float64` keyed on the user's local day. (Implementation may bucket in
Go from a ranged `List` instead of SQL date_trunc, as long as bucketing uses `loc`; either is fine.)

### 2b. Consent toggle
- Extend the `/me` profile response with `share_progress` (add `ShareProgress bool json:"share_progress"`
  to `user.User` and ensure `Me` returns it — it already returns the `User`).
- New handler + route: `PATCH /v1/me/share-progress`, body `{ "share_progress": bool }`, returns the
  updated profile via `httpx.OK`. Add `user.Repository.SetShareProgress(ctx, userID, bool) error`.

### 2c. Compare endpoint — extend the `social` package
- `GET /v1/friends/progress` → `httpx.OK({ me: ProgressView, friends: []FriendProgressView })`:
  - `ProgressView { streak_days, adherence_days, adherence_window }`.
  - `FriendProgressView { id, display_name, sharing bool, streak_days?, adherence_days? }` — the
    metric fields are populated **only when that friend's `share_progress` is true**; otherwise
    `sharing:false` and the numbers are omitted (pointer/omitempty).
- Service `CompareProgress(ctx, userID, day, loc)`:
  1. Compute `me` via `progress.Compute` (always).
  2. List accepted friends (`social.Repository.ListAccepted`) — need each friend's `share_progress`
     and `target_kcal`. Extend `ListAccepted`'s projection to also return `share_progress` +
     `target_kcal`, OR add a sibling `ListAcceptedForCompare` returning a richer row. (Prefer a new
     method to avoid changing A's `FriendView` contract.)
  3. For each friend: if `share_progress`, compute their metrics via `progress.Compute`; else emit
     `{id, display_name, sharing:false}`.
- **Consent enforced server-side** — a non-sharing friend's numbers are never computed into the
  response. Only accepted friends appear.
- Wire the new social route into the authed `/v1` group next to the other `/friends*` routes.

## 3. Mobile

### Types (`apps/mobile/src/api/types.ts`)
```ts
export interface ProgressView { streak_days: number; adherence_days: number; adherence_window: number }
export interface FriendProgress {
  id: string;
  display_name: string;
  sharing: boolean;
  streak_days?: number;
  adherence_days?: number;
}
export interface FriendsProgress { me: ProgressView; friends: FriendProgress[] }
```
Add `share_progress: boolean` to the existing `Profile` type.

### Hooks (`apps/mobile/src/api/hooks.ts`)
- `useFriendsProgress()` — `GET /v1/friends/progress`, key `["friends-progress"]`.
- `useSetShareProgress()` — `PATCH /v1/me/share-progress` body `{share_progress}`; invalidates
  `["profile"]` and `["friends-progress"]`.

### UI (`apps/mobile/app/friends.tsx` + new component)
- **Toggle:** a "Share my progress" row with a `Switch` (from `react-native`) bound to
  `useProfile().data?.share_progress`, calling `useSetShareProgress().mutate({share_progress})` on
  change. Placed at the top of the leaderboard section. Copy makes the privacy explicit
  ("Friends can see your streak and on-target days").
- **New `apps/mobile/src/components/social/FriendsLeaderboard.tsx`**: given `FriendsProgress`,
  renders:
  - A **ranked list** of you + sharing friends, sorted by `streak_days` desc (ties: adherence_days
    desc), each row: rank, name (your row highlighted / labeled "You"), `streak` (with a small flame
    or "d" unit) and "N/7 on target".
  - Friends with `sharing:false` grouped below under a **"Not sharing"** subheading (name only).
  - Empty state when you have no friends yet (reuse the existing Friends empty copy).
- `friends.tsx` composes: existing requests + add-friend + friends-management, plus the toggle and
  `<FriendsLeaderboard>` fed by `useFriendsProgress()`.

## 4. Privacy, errors, edge cases
- `share_progress` defaults **false**; the compare endpoint never serializes a non-sharing friend's
  metrics (enforced in the service, not just the UI).
- Your own metrics are always visible to you.
- Not-yet-onboarded users (`target_kcal == 0`) → `adherence_days == 0` (no divide/relative error).
- Only **accepted** friends appear in the compare response.
- All mobile failures visible (inline text); each mutation invalidates its queries; the toggle
  reflects server truth (invalidate `["profile"]`).

## 5. Testing

### Backend (vs `kora_test`, `-race -p1 -count=1`)
- `progress.Compute`: streak matches the dashboard's logic on the same data; adherence counts a day
  exactly at ±10% boundary correctly (in-band counted, out-of-band not); `target_kcal==0` → 0.
- `DailyKcal`: buckets multi-day logs into correct local-day sums.
- `SetShareProgress` persists; `/me` reflects it.
- `CompareProgress`: a **sharing** friend returns metrics; a **non-sharing** friend returns
  `sharing:false` and NO numbers; a pending (non-accepted) relationship is excluded; `me` is always
  present.
- Handler: `GET /friends/progress` shape; `PATCH /me/share-progress` 200 + toggles.

### Mobile (`npx tsc --noEmit` + `npm test -- --ci`)
- `useFriendsProgress` (URL/key), `useSetShareProgress` (URL/body/invalidation).
- Toggle: flipping the Switch calls the mutation with the new value.
- `FriendsLeaderboard`: sorts by streak desc; renders "N/7 on target"; groups `sharing:false` under
  "Not sharing"; highlights the "You" row; empty state.

## Out of scope (YAGNI — later sub-projects / deferred)
- Per-friend visibility; configurable adherence window; friends' historical charts.
- Competitions / prizes / formal leaderboard seasons (sub-project D).
- Notifications when a friend passes you (sub-project E).
- Refactoring the dashboard's existing streak calc to use `internal/progress` (kept separate to
  limit blast radius; a future cleanup).

## Task decomposition (for the plan)
1. Migration `000010` + `user.ShareProgress` + `SetShareProgress` + `PATCH /me/share-progress`.
2. `internal/progress` package (`Compute` + `foodlog.Repository.DailyKcal`) with unit tests.
3. `social` compare service + `GET /v1/friends/progress` handler + route (+ accepted-with-share
   repo method).
4. Mobile types + `useFriendsProgress` + `useSetShareProgress` hooks.
5. `FriendsLeaderboard` component.
6. Friends-screen wiring: share toggle + leaderboard.
