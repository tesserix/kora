# Design — Scheduler + Time-Triggered Challenge Events (Social sub-project E2a)

**Date:** 2026-07-26
**Branch:** `phase-9-scheduler` (new, off `main` HEAD `137d82b`)
**Type:** Backend feature (+ small mobile addition) — builds on Competitions (D) + Notification Feed (E1)

## Context

First half of **E2** (push was deferred: OS push needs an EAS project + APNs credentials + a physical
device, none of which are available). E2a is the fully-buildable, fully-testable half: a **scheduler**
that writes E1 notification rows when challenges start, end, and when someone passes you in the
standings. It reuses the E1 feed entirely — there is **no new delivery channel**, just a goroutine
ticker, a little fire-once bookkeeping, and three new notification types. When OS push (E2b) lands
later, it delivers these same rows.

Reuse points:
- The E1 `notifications` package (rows/feed) + its `Service` — E2a adds three writer methods.
- `challenges.Service.Detail`'s ranked-standings computation — extracted so the scheduler shares it.
- `progress.WindowScore` (scoring), the `challenges` repo/model, the app's long-running API process
  (`cmd/api/main.go` graceful-shutdown pattern), `slog` logging.

### Product decisions (locked during brainstorming — user approved)
- **Scope:** scheduler + all three time-triggered events NOW; OS push (device tokens, Expo/FCM,
  scheduler-independent) deferred to E2b behind the credential/device gate.
- **Events:** `challenge_started` (to all participants), `challenge_ended` + winner (to all
  participants), `challenge_passed` (to the participant who dropped, actor = the person now directly
  ahead).
- **Cadence:** a `time.Ticker`, default **every 5 minutes**, env-configurable. Start/end are
  day-granular so precision is not critical; "passed" is intentionally approximate.
- **Idempotency:** fire-once via `started_notified_at` / `ended_notified_at` columns; **notify first,
  mark second** (a notify failure leaves the mark unset → retried next tick).

## 1. Data model (migration `000014_challenge_schedule`)
- `challenges`: add `started_notified_at timestamptz null`, `ended_notified_at timestamptz null`.
- `challenge_participants`: add `last_rank int null` (each participant's last-seen 1-based standing).
- `.down.sql` drops the three columns.
- Model additions: `Challenge` gains `StartedNotifiedAt *time.Time` / `EndedNotifiedAt *time.Time`
  (`gorm` columns `started_notified_at` / `ended_notified_at`, set explicitly via `Update` — NOT
  `autoCreateTime`); `ChallengeParticipant` gains `LastRank *int` (`last_rank`).

## 2. Backend — `challenges` additions

### Extract shared standings (no duplicated ranking math)
- Add unexported `standingsFor(ctx, ch *Challenge, loc) ([]Standing, error)` = the exact
  score-per-participant + `sort.SliceStable` (score desc, DisplayName asc) block currently inline in
  `Detail`. Refactor `Detail` to call `standingsFor(ctx, ch, loc)` (it already holds `ch` from
  `mustMember` — no extra fetch). Behavior unchanged; existing Detail tests stay green.
- Add exported `Standings(ctx, challengeID uuid.UUID, loc *time.Location) ([]Standing, error)` for
  the scheduler: `FindByID` → 404 if nil → `standingsFor`. No membership gating (internal use).

### New repository methods (for the scheduler)
- `ListDueForStart(ctx, today time.Time) ([]Challenge, error)` — `start_date <= today AND
  started_notified_at IS NULL`.
- `ListDueForEnd(ctx, today time.Time) ([]Challenge, error)` — `end_date < today AND
  ended_notified_at IS NULL`.
- `ListActive(ctx, today time.Time) ([]Challenge, error)` — `start_date <= today AND end_date >=
  today`.
- `MarkStartedNotified(ctx, id) error` / `MarkEndedNotified(ctx, id) error` — set the column to `now()`.
- `ParticipantIDs(ctx, challengeID) ([]uuid.UUID, error)` — all participant user ids (for the
  started/ended fan-out recipient list).
- `ParticipantRanks(ctx, challengeID) (map[uuid.UUID]*int, error)` — current `last_rank` per
  participant.
- `SetLastRanks(ctx, challengeID uuid.UUID, ranks map[uuid.UUID]int) error` — persist the new ranks
  (one statement per participant is fine at expected sizes).
- `today` compares against the `date` columns; `today` is derived once per tick (see §4 loc note).

## 3. Backend — `notifications` writer methods (three new types)
- Model consts: `TypeChallengeStarted = "challenge_started"`, `TypeChallengeEnded =
  "challenge_ended"`, `TypeChallengePassed = "challenge_passed"`.
- `notifications.Service` gains (the scheduler is the only caller; recipients are passed in, since the
  scheduler already computes them):
  - `ChallengeStarted(ctx, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID)
    error` → one `challenge_started` row per participant, `actor = creatorID`, `entity = challengeID`.
  - `ChallengeEnded(ctx, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error`
    → one `challenge_ended` row per participant, `actor = winnerID`, `entity = challengeID`.
  - `ChallengePassed(ctx, challengeID, passedUserID, aheadUserID uuid.UUID) error` → one
    `challenge_passed` row to `passedUserID`, `actor = aheadUserID`, `entity = challengeID`.
  - Each per-row `Create` failure is recorded (firstErr) but does not abort the rest (matches the
    existing `ChallengeCreated` fan-out).
- Note: `challenge_started`'s `actor = creatorID` is a filler to satisfy the NOT-NULL/actor-join; the
  mobile message ignores the actor for that type (see §5).

## 4. Backend — `internal/scheduler` package
- `Scheduler` holds a `challengeSource` (interface over the new `challenges` methods + `Standings`) and
  a `notifier` (interface over the three `notifications.Service` methods). `NewScheduler(...)`.
- `Run(ctx context.Context)` — a `time.Ticker(interval)` loop; on each tick calls `Tick(ctx, now)`;
  returns when `ctx` is cancelled (graceful shutdown). A `Tick` error is logged (`slog`) and the loop
  continues — the scheduler never crashes the API.
- **`Tick(ctx, now time.Time) error`** — the testable core (called directly in tests, no timer):
  - `today` and the scoring `loc` come from a single **app-default location** (the existing
    `DefaultTimezone`, e.g. Sydney) — NOT per-viewer. This is a deliberate approximation: `Detail`
    scores in the viewer's loc, the scheduler in a fixed loc, so day-boundary scores can differ
    slightly. Winner/pass detection stay deterministic. (Documented tradeoff.)
  - **Started:** `for ch in ListDueForStart(today)`: `pids := ParticipantIDs(ch.ID)` →
    `notifier.ChallengeStarted(ch.ID, pids, ch.CreatorID)` → on success `MarkStartedNotified(ch.ID)`.
  - **Ended:** `for ch in ListDueForEnd(today)`: `st := Standings(ch.ID, loc)`; `winner :=
    st[0].UserID` when non-empty (a challenge always has ≥1 participant — creator auto-joins);
    `pids := ParticipantIDs(ch.ID)` → `notifier.ChallengeEnded(ch.ID, pids, winner)` →
    `MarkEndedNotified(ch.ID)`.
  - **Passed:** `for ch in ListActive(today)`: `st := Standings(ch.ID, loc)` (ranked);
    `prev := ParticipantRanks(ch.ID)`; for each `st[i]` (rank `i+1`): if `prev[uid] != nil && rank >
    *prev[uid]` → `ahead := st[i-1].UserID` → `notifier.ChallengePassed(ch.ID, uid, ahead)`. After the
    loop, `SetLastRanks(ch.ID, {uid: rank})` for all. First-seen (`prev[uid] == nil`) sets the
    baseline without notifying.
- Config: `SchedulerInterval` (env `SCHEDULER_INTERVAL`, default `5m`); `SchedulerEnabled` implicitly
  true when the API runs (a `0`/empty interval disables it — the API still serves).

### Wiring (`cmd/api/main.go`)
After `db` connects, construct the scheduler (challenges repo/service + notifications service), and
`go sched.Run(schedCtx)` where `schedCtx` is cancelled during graceful shutdown (add a
`context.WithCancel` cancelled alongside `srv.Shutdown`). The scheduler shares the same DB.

## 5. Mobile
- Add three `NotificationType` values (`challenge_started｜challenge_ended｜challenge_passed`) to the
  union, their `message()` strings, and their deep-link (all → `/challenge/:entity_id`) in
  `app/notifications.tsx`:
  - `challenge_started` → *"A challenge you joined has started"* (ignores actor).
  - `challenge_ended` → *"{actor_name} won a challenge"* (the winner is the actor).
  - `challenge_passed` → *"{actor_name} passed you in a challenge"*.
- No new screens — these flow into the existing inbox + unread badge.

## 6. Privacy, edges, testing
- The scheduler writes only `challenge_*` notifications to **participants** of the challenge (opt-in =
  consent, same as D) — never to non-participants. `challenge_passed` goes only to the dropped user.
- Idempotency: started/ended fire exactly once (notify-then-mark; a crash between notify and mark
  re-fires next tick — acceptable rare dup). Passed can re-notify across ticks if a user keeps
  dropping — that is the intended behavior (each distinct drop is a pass).
- **Known minor redundancy (accepted):** a challenge created with `start_date == today` (the common
  case, since `Create` sets `start = today`) fires `challenge_created` at creation AND
  `challenge_started` on the next tick — semantically distinct ("made" vs "begun"), accepted for MVP.
- **loc approximation (accepted):** scheduler scores in the app-default loc, so its standings can
  differ from a viewer's `Detail` at day boundaries — deterministic, edge-only.
- Winner is always defined for an ended challenge (≥1 participant). Ties broken by name (stable sort).
- **Backend tests** (`Tick` unit-tested with stubbed `challengeSource` + `notifier` — no DB for the
  logic):
  - started fires to all participants once, then `ListDueForStart` excludes it (idempotency via the
    stub honoring MarkStartedNotified);
  - ended notifies with the correct winner (top standing) to all participants, marks ended;
  - passed fires only when a participant's rank worsens vs `last_rank`, with the correct "ahead" actor,
    and NOT on first-seen (nil last_rank); baseline ranks are written every tick;
  - a notify error leaves the fire-once mark unset (not marked).
  - `challenges` repo (DB, `kora_test`): the new list/mark/rank methods (due-for-start/end honor the
    notified-at NULL filter; ListActive bounds; SetLastRanks round-trips; ParticipantIDs).
  - `notifications` service: the three writer methods write the right type/actor/entity per recipient.
  - `Standings`/`standingsFor` refactor: existing Detail tests stay green; a direct `Standings` test
    returns the ranked list.
  - Migration `000014` up/down applies cleanly to `kora_test`.
- **Mobile tests:** the three new types render the right message + deep-link to `/challenge/:id`.
- **Live-smoke (controller, after merge):** set a challenge's `start_date`/`end_date` to force a
  started/ended tick and watch the feed rows + badge; drive a rank change for a passed notification.

## Out of scope (YAGNI — E2b / later)
- OS push (device tokens, Expo/FCM send, permissions), which needs EAS + APNs + a device — **E2b**.
- Per-user notification preferences, digest/batching, quiet hours.
- Distributed-scheduler locking (single API instance assumed).
- Per-viewer-tz scheduler scoring (fixed app-default loc used).

## Task decomposition (for the plan) — ~6 tasks
1. Migration `000014` + `challenges` model fields + repo methods (due-for-start/end, active, mark
   started/ended, ParticipantIDs, ParticipantRanks, SetLastRanks).
2. Extract `challenges.standingsFor` + `Standings`; refactor `Detail` (behavior-preserving).
3. `notifications` three writer methods + type consts.
4. `internal/scheduler` package: `Scheduler` + `Run` + `Tick` (started/ended/passed), stub-tested.
5. Wire the ticker into `cmd/api/main.go` + `SCHEDULER_INTERVAL` config.
6. Mobile: three new `NotificationType` values + messages + deep-links.
