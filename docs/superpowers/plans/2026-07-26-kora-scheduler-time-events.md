# Scheduler + Time-Triggered Challenge Events (Social E2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A goroutine ticker in the long-running API writes E1 notification feed rows when challenges start, end (with the winner), and when someone passes you in the standings.

**Architecture:** New `internal/scheduler` package with a `Scheduler.Run(ctx)` ticker loop and a testable `Tick(ctx, now)` core. It depends on two small ports over `challenges` (a `challengeData` repo port for due-lists / mark-notified / ranks, and a `standingsSource` service port for ranked `Standings`) plus a `notifier` port over `notifications.Service` (three new writer methods for three new notification types). Fire-once via new `started_notified_at` / `ended_notified_at` columns; pass-detection via a new `last_rank` column. No push, no new tables. Wired into `cmd/api/main.go`, cancelled on graceful shutdown.

**Tech Stack:** Go 1.26 + Gin + GORM + Postgres (backend); Expo SDK 57 / React Native (mobile, small message additions).

## Global Constraints

- **Idempotency — notify first, mark second:** started/ended fire exactly once; a notify failure leaves the fire-once column unset so the next tick retries. Never mark before a successful notify.
- **Best-effort, never crash the API:** a `Tick` error is logged (`slog`) and the loop continues; per-challenge errors inside a tick are logged and skip that challenge, not the whole tick.
- **Opt-in = consent:** the scheduler writes `challenge_*` notifications only to **participants** of the challenge; `challenge_passed` only to the dropped user. Never to non-participants.
- **Fixed scheduler loc (accepted approximation):** the scheduler derives `today` and scores standings in the app-default location (`user.DefaultTimezone` = `Australia/Sydney`), NOT per-viewer — so its standings can differ from a viewer's `Detail` at day boundaries. Deterministic, edge-only.
- **Three new notification types (exact strings):** `challenge_started`, `challenge_ended`, `challenge_passed`. `challenge_started`'s `actor_id` is the creator (filler for the NOT-NULL/actor-join; the mobile message ignores it); `challenge_ended`'s actor is the winner; `challenge_passed`'s actor is the person now directly ahead.
- **Date comparisons:** the new repo queries compare the `date` columns against `today.Format("2006-01-02")` (a loc-local calendar-date string) — tz-safe. `start_date <= today` (started/active), `end_date < today` (ended), `start_date <= today AND end_date >= today` (active).
- **Conventional single-line commits, no signature.** Backend DB tests vs `kora_test`; apply new migrations first with `go run ./cmd/migrate`. Tests **FOREGROUND**. Stale RED Go LSP diagnostics after a test-before-impl step are always stale — verify with `go build ./...` / `go test`.
- **Mobile:** `npx tsc --noEmit` + `npm test -- --ci`; no `console.log`; no `any`.

---

### Task 1: Migration `000014` + `challenges` schedule state + repo methods

**Files:**
- Create: `api/internal/database/migrations/000014_challenge_schedule.up.sql`
- Create: `api/internal/database/migrations/000014_challenge_schedule.down.sql`
- Modify: `api/internal/challenges/model.go`
- Modify: `api/internal/challenges/repository.go`
- Test: `api/internal/challenges/schedule_repository_test.go`

**Interfaces:**
- Consumes: existing `challenges` model/repo, `uuid.UUID`, GORM.
- Produces:
  - `Challenge` gains `StartedNotifiedAt *time.Time` / `EndedNotifiedAt *time.Time`; `ChallengeParticipant` gains `LastRank *int`.
  - `Repository` methods: `ListDueForStart(ctx, today time.Time) ([]Challenge, error)`, `ListDueForEnd(ctx, today time.Time) ([]Challenge, error)`, `ListActive(ctx, today time.Time) ([]Challenge, error)`, `MarkStartedNotified(ctx, id uuid.UUID) error`, `MarkEndedNotified(ctx, id uuid.UUID) error`, `ParticipantIDs(ctx, challengeID uuid.UUID) ([]uuid.UUID, error)`, `ParticipantRanks(ctx, challengeID uuid.UUID) (map[uuid.UUID]*int, error)`, `SetLastRanks(ctx, challengeID uuid.UUID, ranks map[uuid.UUID]int) error`.

- [ ] **Step 1: Migration up**

`api/internal/database/migrations/000014_challenge_schedule.up.sql`:
```sql
ALTER TABLE challenges ADD COLUMN started_notified_at TIMESTAMPTZ;
ALTER TABLE challenges ADD COLUMN ended_notified_at TIMESTAMPTZ;
ALTER TABLE challenge_participants ADD COLUMN last_rank INTEGER;
```

- [ ] **Step 2: Migration down**

`api/internal/database/migrations/000014_challenge_schedule.down.sql`:
```sql
ALTER TABLE challenge_participants DROP COLUMN IF EXISTS last_rank;
ALTER TABLE challenges DROP COLUMN IF EXISTS ended_notified_at;
ALTER TABLE challenges DROP COLUMN IF EXISTS started_notified_at;
```

- [ ] **Step 3: Apply to `kora_test`**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`
Expected: migrates to version 14, no error.

- [ ] **Step 4: Add the model fields**

In `api/internal/challenges/model.go`, add to `Challenge` (after `CreatedAt`):
```go
	StartedNotifiedAt *time.Time `gorm:"column:started_notified_at" json:"-"`
	EndedNotifiedAt   *time.Time `gorm:"column:ended_notified_at" json:"-"`
```
And to `ChallengeParticipant` (after `JoinedAt`):
```go
	LastRank *int `gorm:"column:last_rank" json:"-"`
```

- [ ] **Step 5: Write the failing repo test**

`api/internal/challenges/schedule_repository_test.go`:
```go
package challenges

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestDueForStartAndMark(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Started", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })

	today := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	due, err := repo.ListDueForStart(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(due, ch.ID))

	require.NoError(t, repo.MarkStartedNotified(context.Background(), ch.ID))
	due, err = repo.ListDueForStart(context.Background(), today)
	require.NoError(t, err)
	require.False(t, containsID(due, ch.ID), "marked challenge no longer due for start")
}

func TestDueForEndAndActive(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ended, err := repo.Create(context.Background(), gid, owner, "Ended", MetricLogged, start, start.AddDate(0, 0, 5)) // ends 2026-07-06
	require.NoError(t, err)
	active, err := repo.Create(context.Background(), gid, owner, "Active", MetricLogged, start, start.AddDate(0, 0, 40)) // ends 2026-08-10
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	today := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	dueEnd, err := repo.ListDueForEnd(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(dueEnd, ended.ID))
	require.False(t, containsID(dueEnd, active.ID))

	act, err := repo.ListActive(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(act, active.ID))
	require.False(t, containsID(act, ended.ID))
}

func TestParticipantIDsRanksRoundTrip(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	other := seedUser(t, db, "Other", 1800)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Ranks", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))

	ids, err := repo.ParticipantIDs(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Len(t, ids, 2)

	// initial ranks are nil
	ranks, err := repo.ParticipantRanks(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Nil(t, ranks[owner])

	require.NoError(t, repo.SetLastRanks(context.Background(), ch.ID, map[uuid.UUID]int{owner: 1, other: 2}))
	ranks, err = repo.ParticipantRanks(context.Background(), ch.ID)
	require.NoError(t, err)
	require.NotNil(t, ranks[owner])
	require.Equal(t, 1, *ranks[owner])
	require.Equal(t, 2, *ranks[other])
}

func containsID(chs []Challenge, id uuid.UUID) bool {
	for _, c := range chs {
		if c.ID == id {
			return true
		}
	}
	return false
}
```
(`testDB`, `seedUser`, `seedGroup` already exist in `repository_test.go`.)

- [ ] **Step 6: Run to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/ -run 'TestDueFor|TestParticipantIDsRanks' -v`
Expected: FAIL — the new repo methods are undefined.

- [ ] **Step 7: Add the repo methods**

Append to `api/internal/challenges/repository.go`:
```go
func (r Repository) ListDueForStart(ctx context.Context, today time.Time) ([]Challenge, error) {
	out := []Challenge{}
	err := r.db.WithContext(ctx).
		Where("start_date <= ? AND started_notified_at IS NULL", today.Format("2006-01-02")).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list due for start: %w", err)
	}
	return out, nil
}

func (r Repository) ListDueForEnd(ctx context.Context, today time.Time) ([]Challenge, error) {
	out := []Challenge{}
	err := r.db.WithContext(ctx).
		Where("end_date < ? AND ended_notified_at IS NULL", today.Format("2006-01-02")).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list due for end: %w", err)
	}
	return out, nil
}

func (r Repository) ListActive(ctx context.Context, today time.Time) ([]Challenge, error) {
	d := today.Format("2006-01-02")
	out := []Challenge{}
	err := r.db.WithContext(ctx).
		Where("start_date <= ? AND end_date >= ?", d, d).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list active: %w", err)
	}
	return out, nil
}

func (r Repository) MarkStartedNotified(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Model(&Challenge{}).Where("id = ?", id).
		Update("started_notified_at", gorm.Expr("now()")).Error; err != nil {
		return fmt.Errorf("challenges: mark started notified: %w", err)
	}
	return nil
}

func (r Repository) MarkEndedNotified(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Model(&Challenge{}).Where("id = ?", id).
		Update("ended_notified_at", gorm.Expr("now()")).Error; err != nil {
		return fmt.Errorf("challenges: mark ended notified: %w", err)
	}
	return nil
}

func (r Repository) ParticipantIDs(ctx context.Context, challengeID uuid.UUID) ([]uuid.UUID, error) {
	out := []uuid.UUID{}
	err := r.db.WithContext(ctx).Model(&ChallengeParticipant{}).
		Where("challenge_id = ?", challengeID).
		Pluck("user_id", &out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: participant ids: %w", err)
	}
	return out, nil
}

func (r Repository) ParticipantRanks(ctx context.Context, challengeID uuid.UUID) (map[uuid.UUID]*int, error) {
	type row struct {
		UserID   uuid.UUID
		LastRank *int
	}
	var rows []row
	err := r.db.WithContext(ctx).Model(&ChallengeParticipant{}).
		Select("user_id, last_rank").
		Where("challenge_id = ?", challengeID).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: participant ranks: %w", err)
	}
	m := make(map[uuid.UUID]*int, len(rows))
	for _, rw := range rows {
		m[rw.UserID] = rw.LastRank
	}
	return m, nil
}

func (r Repository) SetLastRanks(ctx context.Context, challengeID uuid.UUID, ranks map[uuid.UUID]int) error {
	for uid, rank := range ranks {
		if err := r.db.WithContext(ctx).Model(&ChallengeParticipant{}).
			Where("challenge_id = ? AND user_id = ?", challengeID, uid).
			Update("last_rank", rank).Error; err != nil {
			return fmt.Errorf("challenges: set last ranks: %w", err)
		}
	}
	return nil
}
```
(`gorm` and `fmt` are already imported in `repository.go`.)

- [ ] **Step 8: Run to verify it passes**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/`
Expected: PASS (new + existing). `go build ./...` clean.

- [ ] **Step 9: Commit**

```bash
git add api/internal/database/migrations/000014_challenge_schedule.up.sql api/internal/database/migrations/000014_challenge_schedule.down.sql api/internal/challenges/model.go api/internal/challenges/repository.go api/internal/challenges/schedule_repository_test.go
git commit -m "feat(challenges): schedule state columns + scheduler repo queries"
```

---

### Task 2: Extract `challenges.Standings` (refactor `Detail`)

**Files:**
- Modify: `api/internal/challenges/service.go`
- Test: `api/internal/challenges/standings_test.go`

**Interfaces:**
- Consumes: `progress.WindowScore`, the `Standing`/`Challenge` types, `s.repo.ListParticipantsForScoring`/`FindByID`.
- Produces: `Service.Standings(ctx, challengeID uuid.UUID, loc *time.Location) ([]Standing, error)` (no gating; `ErrNotFound` if absent). `Detail` behavior unchanged.

- [ ] **Step 1: Write the failing test**

`api/internal/challenges/standings_test.go`:
```go
package challenges

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/groups"
)

func TestStandingsRanksByScoreDescNameAsc(t *testing.T) {
	g, alice, bob := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	// alice 2 logged days, bob 1
	svc := NewService(store, stubGroups{m: member(g, alice, groups.RoleOwner)}, stubLogs{kcal: map[uuid.UUID]map[string]float64{
		alice: {"2026-07-01": 2000, "2026-07-02": 2000},
		bob:   {"2026-07-01": 2000},
	}})
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: alice, Title: "S", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 7)}
	store.find = &ch
	store.scoring = []ScoringRow{{ID: bob, DisplayName: "Bob", TargetKcal: 2000}, {ID: alice, DisplayName: "Alice", TargetKcal: 2000}}

	st, err := svc.Standings(context.Background(), ch.ID, time.UTC)
	require.NoError(t, err)
	require.Len(t, st, 2)
	require.Equal(t, "Alice", st[0].DisplayName)
	require.Equal(t, 2, st[0].Score)
	require.Equal(t, "Bob", st[1].DisplayName)
}

func TestStandingsUnknownChallengeNotFound(t *testing.T) {
	store := newStubStore()
	svc := NewService(store, stubGroups{}, stubLogs{})
	_, err := svc.Standings(context.Background(), uuid.New(), time.UTC)
	require.ErrorIs(t, err, ErrNotFound)
}
```
Note: `member(...)` and `stubGroups`/`stubStore`/`stubLogs`/`newStubStore` already exist in `service_test.go` (same package). `member(g, u uuid.UUID, role groups.Role)` — pass `groups.RoleOwner`, importing `github.com/tesserix/kora/api/internal/groups` in this test file (as shown in the imports above).

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && go test ./internal/challenges/ -run TestStandings -v`
Expected: FAIL — `Standings` undefined.

- [ ] **Step 3: Extract `standingsFor` + add `Standings`; refactor `Detail`**

In `api/internal/challenges/service.go`, add:
```go
// standingsFor scores every participant and ranks them (score desc, name asc).
func (s Service) standingsFor(ctx context.Context, ch *Challenge, loc *time.Location) ([]Standing, error) {
	rows, err := s.repo.ListParticipantsForScoring(ctx, ch.ID)
	if err != nil {
		return nil, err
	}
	standings := make([]Standing, 0, len(rows))
	for _, r := range rows {
		score, err := progress.WindowScore(ctx, s.logs, r.ID, string(ch.Metric), r.TargetKcal, ch.StartDate, ch.EndDate, loc)
		if err != nil {
			return nil, err
		}
		standings = append(standings, Standing{UserID: r.ID, DisplayName: r.DisplayName, Score: score})
	}
	sort.SliceStable(standings, func(i, j int) bool {
		if standings[i].Score != standings[j].Score {
			return standings[i].Score > standings[j].Score
		}
		return standings[i].DisplayName < standings[j].DisplayName
	})
	return standings, nil
}

// Standings returns the ranked standings for a challenge (no membership gate;
// used internally, e.g. by the scheduler).
func (s Service) Standings(ctx context.Context, challengeID uuid.UUID, loc *time.Location) ([]Standing, error) {
	ch, err := s.repo.FindByID(ctx, challengeID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, ErrNotFound
	}
	return s.standingsFor(ctx, ch, loc)
}
```
Then in `Detail`, replace the inline scoring+sort block (from `rows, err := s.repo.ListParticipantsForScoring(...)` through the `sort.SliceStable(...)` call) with:
```go
	standings, err := s.standingsFor(ctx, ch, loc)
	if err != nil {
		return ChallengeDetail{}, err
	}
```
Leave the rest of `Detail` (status, joined, owner, winner, return) unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && go test ./internal/challenges/ -run 'TestStandings|TestDetail' -v` then the whole package with DB: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/`
Expected: PASS — new Standings tests + existing Detail tests unchanged. `go build ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/challenges/service.go api/internal/challenges/standings_test.go
git commit -m "refactor(challenges): extract Standings for reuse by the scheduler"
```

---

### Task 3: `notifications` — three time-event writer methods

**Files:**
- Modify: `api/internal/notifications/model.go`
- Modify: `api/internal/notifications/service.go`
- Test: `api/internal/notifications/time_events_test.go`

**Interfaces:**
- Produces: consts `TypeChallengeStarted`/`TypeChallengeEnded`/`TypeChallengePassed`; methods `ChallengeStarted(ctx, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID) error`, `ChallengeEnded(ctx, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error`, `ChallengePassed(ctx, challengeID, passedUserID, aheadUserID uuid.UUID) error`.

- [ ] **Step 1: Add the type consts**

In `api/internal/notifications/model.go`, extend the `const (...)` block:
```go
	TypeChallengeStarted = "challenge_started"
	TypeChallengeEnded   = "challenge_ended"
	TypeChallengePassed  = "challenge_passed"
```

- [ ] **Step 2: Write the failing test**

`api/internal/notifications/time_events_test.go`:
```go
package notifications

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestChallengeStartedWritesToAllParticipants(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, creator, m1, m2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengeStarted(context.Background(), cid, []uuid.UUID{creator, m1, m2}, creator))
	require.Len(t, store.created, 3)
	for _, n := range store.created {
		require.Equal(t, TypeChallengeStarted, n.Type)
		require.Equal(t, creator, n.ActorID)
		require.NotNil(t, n.EntityID)
		require.Equal(t, cid, *n.EntityID)
	}
}

func TestChallengeEndedActorIsWinner(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, winner, m1 := uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengeEnded(context.Background(), cid, []uuid.UUID{winner, m1}, winner))
	require.Len(t, store.created, 2)
	for _, n := range store.created {
		require.Equal(t, TypeChallengeEnded, n.Type)
		require.Equal(t, winner, n.ActorID)
		require.Equal(t, cid, *n.EntityID)
	}
}

func TestChallengePassedWritesOneRowToPassedUser(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, passed, ahead := uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengePassed(context.Background(), cid, passed, ahead))
	require.Len(t, store.created, 1)
	require.Equal(t, TypeChallengePassed, store.created[0].Type)
	require.Equal(t, passed, store.created[0].UserID)
	require.Equal(t, ahead, store.created[0].ActorID)
	require.Equal(t, cid, *store.created[0].EntityID)
}
```
(`stubStore`/`stubMembers` already exist in `service_test.go`.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd api && go test ./internal/notifications/ -run 'TestChallengeStarted|TestChallengeEnded|TestChallengePassed' -v`
Expected: FAIL — the three methods are undefined.

- [ ] **Step 4: Add the writer methods**

Append to `api/internal/notifications/service.go`:
```go
func (s Service) ChallengeStarted(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID) error {
	cid := challengeID
	var firstErr error
	for _, uid := range participantIDs {
		if err := s.store.Create(ctx, Notification{UserID: uid, ActorID: creatorID, Type: TypeChallengeStarted, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) ChallengeEnded(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error {
	cid := challengeID
	var firstErr error
	for _, uid := range participantIDs {
		if err := s.store.Create(ctx, Notification{UserID: uid, ActorID: winnerID, Type: TypeChallengeEnded, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) ChallengePassed(ctx context.Context, challengeID, passedUserID, aheadUserID uuid.UUID) error {
	cid := challengeID
	return s.store.Create(ctx, Notification{UserID: passedUserID, ActorID: aheadUserID, Type: TypeChallengePassed, EntityID: &cid})
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd api && go test ./internal/notifications/ -run 'TestChallenge' -v` then `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/notifications/`
Expected: PASS. `go build ./...` clean.

- [ ] **Step 6: Commit**

```bash
git add api/internal/notifications/model.go api/internal/notifications/service.go api/internal/notifications/time_events_test.go
git commit -m "feat(notifications): started/ended/passed writer methods + types"
```

---

### Task 4: `internal/scheduler` package (`Scheduler` + `Run` + `Tick`)

**Files:**
- Create: `api/internal/scheduler/scheduler.go`
- Test: `api/internal/scheduler/scheduler_test.go`

**Interfaces:**
- Consumes: `challenges.Challenge`/`challenges.Standing`; the `challengeData` methods (Task 1, `challenges.Repository` satisfies); `standingsSource.Standings` (Task 2, `challenges.Service` satisfies); the three `notifier` methods (Task 3, `notifications.Service` satisfies).
- Produces: `scheduler.New(data challengeData, stand standingsSource, notif notifier, loc *time.Location, interval time.Duration, log *slog.Logger) *Scheduler`; `Run(ctx)`; `Tick(ctx, now time.Time) error`.

- [ ] **Step 1: Write the failing test**

`api/internal/scheduler/scheduler_test.go`:
```go
package scheduler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/challenges"
)

func intp(i int) *int { return &i }

type stubData struct {
	dueStart, dueEnd, active []challenges.Challenge
	participants             map[uuid.UUID][]uuid.UUID
	ranks                    map[uuid.UUID]map[uuid.UUID]*int
	standings                map[uuid.UUID][]challenges.Standing
	startedMarked, endedMarked []uuid.UUID
	setRanks                 map[uuid.UUID]map[uuid.UUID]int
}

func (s *stubData) ListDueForStart(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.dueStart, nil
}
func (s *stubData) ListDueForEnd(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.dueEnd, nil
}
func (s *stubData) ListActive(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.active, nil
}
func (s *stubData) ParticipantIDs(_ context.Context, cid uuid.UUID) ([]uuid.UUID, error) {
	return s.participants[cid], nil
}
func (s *stubData) ParticipantRanks(_ context.Context, cid uuid.UUID) (map[uuid.UUID]*int, error) {
	return s.ranks[cid], nil
}
func (s *stubData) SetLastRanks(_ context.Context, cid uuid.UUID, r map[uuid.UUID]int) error {
	if s.setRanks == nil {
		s.setRanks = map[uuid.UUID]map[uuid.UUID]int{}
	}
	s.setRanks[cid] = r
	return nil
}
func (s *stubData) MarkStartedNotified(_ context.Context, id uuid.UUID) error {
	s.startedMarked = append(s.startedMarked, id)
	return nil
}
func (s *stubData) MarkEndedNotified(_ context.Context, id uuid.UUID) error {
	s.endedMarked = append(s.endedMarked, id)
	return nil
}

type stubStand struct{ m map[uuid.UUID][]challenges.Standing }

func (s stubStand) Standings(_ context.Context, cid uuid.UUID, _ *time.Location) ([]challenges.Standing, error) {
	return s.m[cid], nil
}

type startedCall struct {
	cid     uuid.UUID
	pids    []uuid.UUID
	creator uuid.UUID
}
type endedCall struct {
	cid    uuid.UUID
	pids   []uuid.UUID
	winner uuid.UUID
}
type passedCall struct {
	cid, passed, ahead uuid.UUID
}

type stubNotif struct {
	started []startedCall
	ended   []endedCall
	passed  []passedCall
	fail    bool
}

func (s *stubNotif) ChallengeStarted(_ context.Context, cid uuid.UUID, pids []uuid.UUID, creator uuid.UUID) error {
	if s.fail {
		return errors.New("boom")
	}
	s.started = append(s.started, startedCall{cid, pids, creator})
	return nil
}
func (s *stubNotif) ChallengeEnded(_ context.Context, cid uuid.UUID, pids []uuid.UUID, winner uuid.UUID) error {
	s.ended = append(s.ended, endedCall{cid, pids, winner})
	return nil
}
func (s *stubNotif) ChallengePassed(_ context.Context, cid, passed, ahead uuid.UUID) error {
	s.passed = append(s.passed, passedCall{cid, passed, ahead})
	return nil
}

func newLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func now() time.Time         { return time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC) }

func TestTickStartedNotifiesAndMarks(t *testing.T) {
	cid, creator, m1 := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		dueStart:     []challenges.Challenge{{ID: cid, CreatorID: creator}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {creator, m1}},
	}
	notif := &stubNotif{}
	s := New(data, stubStand{}, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.started, 1)
	require.Equal(t, creator, notif.started[0].creator)
	require.Equal(t, []uuid.UUID{cid}, data.startedMarked) // marked after notify
}

func TestTickStartedNotifyErrorDoesNotMark(t *testing.T) {
	cid := uuid.New()
	data := &stubData{dueStart: []challenges.Challenge{{ID: cid}}, participants: map[uuid.UUID][]uuid.UUID{cid: {uuid.New()}}}
	notif := &stubNotif{fail: true}
	s := New(data, stubStand{}, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now())) // tick itself doesn't error
	require.Empty(t, data.startedMarked, "must not mark when notify failed")
}

func TestTickEndedNotifiesWinner(t *testing.T) {
	cid, winner, loser := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		dueEnd:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {winner, loser}},
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: winner, Score: 5}, {UserID: loser, Score: 2}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.ended, 1)
	require.Equal(t, winner, notif.ended[0].winner)
	require.Equal(t, []uuid.UUID{cid}, data.endedMarked)
}

func TestTickPassedFiresOnWorseningNotFirstSeen(t *testing.T) {
	cid, alice, bob := uuid.New(), uuid.New(), uuid.New()
	// alice was rank 1, bob was rank 2; now bob is rank 1, alice rank 2 -> alice was passed by bob.
	data := &stubData{
		active:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {alice, bob}},
		ranks:        map[uuid.UUID]map[uuid.UUID]*int{cid: {alice: intp(1), bob: intp(2)}},
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: bob, DisplayName: "Bob"}, {UserID: alice, DisplayName: "Alice"}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.passed, 1)
	require.Equal(t, alice, notif.passed[0].passed)
	require.Equal(t, bob, notif.passed[0].ahead) // person now directly ahead
	require.Equal(t, 1, data.setRanks[cid][bob])
	require.Equal(t, 2, data.setRanks[cid][alice])
}

func TestTickPassedNoNotifyOnFirstSeen(t *testing.T) {
	cid, alice, bob := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		active:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {alice, bob}},
		ranks:        map[uuid.UUID]map[uuid.UUID]*int{cid: {}}, // no prior ranks
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: bob}, {UserID: alice}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Empty(t, notif.passed, "first-seen sets baseline, no notify")
	require.Equal(t, 1, data.setRanks[cid][bob]) // baseline written
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd api && go test ./internal/scheduler/ -v`
Expected: FAIL / build error — `New`, `Scheduler`, `Tick` undefined.

- [ ] **Step 3: Write `scheduler.go`**

`api/internal/scheduler/scheduler.go`:
```go
// Package scheduler runs a periodic tick that writes challenge time-event
// notifications (started / ended / passed) to the feed.
package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/challenges"
)

// challengeData is the persistence surface (challenges.Repository satisfies it).
type challengeData interface {
	ListDueForStart(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ListDueForEnd(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ListActive(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ParticipantIDs(ctx context.Context, challengeID uuid.UUID) ([]uuid.UUID, error)
	ParticipantRanks(ctx context.Context, challengeID uuid.UUID) (map[uuid.UUID]*int, error)
	SetLastRanks(ctx context.Context, challengeID uuid.UUID, ranks map[uuid.UUID]int) error
	MarkStartedNotified(ctx context.Context, id uuid.UUID) error
	MarkEndedNotified(ctx context.Context, id uuid.UUID) error
}

// standingsSource ranks a challenge (challenges.Service satisfies it).
type standingsSource interface {
	Standings(ctx context.Context, challengeID uuid.UUID, loc *time.Location) ([]challenges.Standing, error)
}

// notifier writes the time-event notifications (notifications.Service satisfies it).
type notifier interface {
	ChallengeStarted(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID) error
	ChallengeEnded(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error
	ChallengePassed(ctx context.Context, challengeID, passedUserID, aheadUserID uuid.UUID) error
}

type Scheduler struct {
	data     challengeData
	stand    standingsSource
	notif    notifier
	loc      *time.Location
	interval time.Duration
	log      *slog.Logger
}

func New(data challengeData, stand standingsSource, notif notifier, loc *time.Location, interval time.Duration, log *slog.Logger) *Scheduler {
	return &Scheduler{data: data, stand: stand, notif: notif, loc: loc, interval: interval, log: log}
}

// Run ticks until ctx is cancelled. A tick error is logged; the loop continues.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Tick(ctx, time.Now()); err != nil {
				s.log.WarnContext(ctx, "scheduler tick failed", "err", err)
			}
		}
	}
}

// Tick performs one pass: started, ended, then passed detection.
func (s *Scheduler) Tick(ctx context.Context, now time.Time) error {
	today := now.In(s.loc)

	due, err := s.data.ListDueForStart(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range due {
		pids, err := s.data.ParticipantIDs(ctx, ch.ID)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: participant ids", "challenge", ch.ID, "err", err)
			continue
		}
		if err := s.notif.ChallengeStarted(ctx, ch.ID, pids, ch.CreatorID); err != nil {
			s.log.WarnContext(ctx, "scheduler: notify started", "challenge", ch.ID, "err", err)
			continue // do not mark → retry next tick
		}
		if err := s.data.MarkStartedNotified(ctx, ch.ID); err != nil {
			s.log.WarnContext(ctx, "scheduler: mark started", "challenge", ch.ID, "err", err)
		}
	}

	ended, err := s.data.ListDueForEnd(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range ended {
		st, err := s.stand.Standings(ctx, ch.ID, s.loc)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: standings (end)", "challenge", ch.ID, "err", err)
			continue
		}
		if len(st) > 0 {
			pids, err := s.data.ParticipantIDs(ctx, ch.ID)
			if err != nil {
				s.log.WarnContext(ctx, "scheduler: participant ids (end)", "challenge", ch.ID, "err", err)
				continue
			}
			if err := s.notif.ChallengeEnded(ctx, ch.ID, pids, st[0].UserID); err != nil {
				s.log.WarnContext(ctx, "scheduler: notify ended", "challenge", ch.ID, "err", err)
				continue // do not mark → retry
			}
		}
		if err := s.data.MarkEndedNotified(ctx, ch.ID); err != nil {
			s.log.WarnContext(ctx, "scheduler: mark ended", "challenge", ch.ID, "err", err)
		}
	}

	active, err := s.data.ListActive(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range active {
		st, err := s.stand.Standings(ctx, ch.ID, s.loc)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: standings (active)", "challenge", ch.ID, "err", err)
			continue
		}
		prev, err := s.data.ParticipantRanks(ctx, ch.ID)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: ranks", "challenge", ch.ID, "err", err)
			continue
		}
		newRanks := make(map[uuid.UUID]int, len(st))
		for i, standing := range st {
			rank := i + 1
			newRanks[standing.UserID] = rank
			if last := prev[standing.UserID]; last != nil && rank > *last {
				ahead := st[i-1].UserID
				if err := s.notif.ChallengePassed(ctx, ch.ID, standing.UserID, ahead); err != nil {
					s.log.WarnContext(ctx, "scheduler: notify passed", "challenge", ch.ID, "err", err)
				}
			}
		}
		if err := s.data.SetLastRanks(ctx, ch.ID, newRanks); err != nil {
			s.log.WarnContext(ctx, "scheduler: set ranks", "challenge", ch.ID, "err", err)
		}
	}
	return nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd api && go test ./internal/scheduler/ -v`
Expected: PASS (6 tests). `go build ./...` + `go vet ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/scheduler/
git commit -m "feat(scheduler): tick writing challenge started/ended/passed notifications"
```

---

### Task 5: Wire the ticker into `main.go` + `SCHEDULER_INTERVAL` config

**Files:**
- Modify: `api/internal/config/config.go`
- Modify: `api/internal/config/config_test.go`
- Modify: `api/cmd/api/main.go`

**Interfaces:**
- Consumes: `config.Config.SchedulerInterval`, `scheduler.New`, `challenges`/`groups`/`foodlog`/`notifications` constructors, `user.DefaultTimezone`.
- Produces: the scheduler goroutine, started when `SchedulerInterval > 0`, cancelled on shutdown.

- [ ] **Step 1: Add the config field**

In `api/internal/config/config.go`: add `"time"` to imports; add `SchedulerInterval time.Duration` to the `Config` struct; in `Load()` add `SchedulerInterval: getdur("SCHEDULER_INTERVAL", 5*time.Minute),`; and add the helper:
```go
func getdur(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
```

- [ ] **Step 2: Add a config test**

In `api/internal/config/config_test.go`, add (unconditional `t.Setenv` for hermeticity — match the file's existing style):
```go
func TestLoadSchedulerInterval(t *testing.T) {
	t.Setenv("SCHEDULER_INTERVAL", "30s")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 30*time.Second, cfg.SchedulerInterval)
}

func TestLoadSchedulerIntervalDefault(t *testing.T) {
	t.Setenv("SCHEDULER_INTERVAL", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 5*time.Minute, cfg.SchedulerInterval)
}
```
(Add `"time"` to the test imports if not present.)

- [ ] **Step 3: Run the config test**

Run: `cd api && go test ./internal/config/ -run TestLoadScheduler -v`
Expected: PASS. (If the existing `TestLoadConfig` reads a fixed set of vars, leave it unchanged — these are new tests.)

- [ ] **Step 4: Wire the scheduler in `main.go`**

In `api/cmd/api/main.go`, add imports (keep sorted): `"github.com/tesserix/kora/api/internal/challenges"`, `"github.com/tesserix/kora/api/internal/foodlog"`, `"github.com/tesserix/kora/api/internal/groups"`, `"github.com/tesserix/kora/api/internal/notifications"`, `"github.com/tesserix/kora/api/internal/scheduler"`, `"github.com/tesserix/kora/api/internal/user"`.

After `resolveHandler := buildResolveHandler(...)` and before the `srv := &http.Server{...}` block, add:
```go
	schedCtx, schedCancel := context.WithCancel(context.Background())
	if cfg.SchedulerInterval > 0 {
		loc, lerr := time.LoadLocation(user.DefaultTimezone)
		if lerr != nil {
			loc = time.UTC
		}
		challengesRepo := challenges.NewRepository(db)
		challengesSvc := challenges.NewService(challengesRepo, groups.NewRepository(db), foodlog.NewRepository(db))
		notifSvc := notifications.NewService(notifications.NewRepository(db), groups.NewRepository(db))
		sched := scheduler.New(challengesRepo, challengesSvc, notifSvc, loc, cfg.SchedulerInterval, logger)
		go sched.Run(schedCtx)
		logger.Info("scheduler started", "interval", cfg.SchedulerInterval.String(), "loc", loc.String())
	}
```
In the shutdown section (after `<-quit`), call `schedCancel()` before `srv.Shutdown(...)`:
```go
	schedCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", "err", err)
	}
```
(If `schedCancel` is unused when the block is skipped, that is fine — it is always called in shutdown. Ensure `schedCtx`/`schedCancel` are declared before the `if` so `schedCancel()` is in scope at shutdown.)

- [ ] **Step 5: Build + vet + full suite**

Run: `cd api && go build ./... && go vet ./...` then `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`
Expected: build/vet clean; all packages green (config + scheduler + challenges + notifications + unaffected).

- [ ] **Step 6: Commit**

```bash
git add api/internal/config/config.go api/internal/config/config_test.go api/cmd/api/main.go
git commit -m "feat(scheduler): wire ticker into the API + SCHEDULER_INTERVAL config"
```

---

### Task 6: Mobile — three new notification types (messages + deep-links)

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/app/notifications.tsx`
- Test: `apps/mobile/app/__tests__/notifications.test.tsx`

**Interfaces:**
- Produces: `NotificationType` union gains `challenge_started｜challenge_ended｜challenge_passed`; `message()` + `targetFor()` handle them.

- [ ] **Step 1: Extend the union**

In `apps/mobile/src/api/types.ts`, change `NotificationType` to:
```typescript
export type NotificationType = "friend_request" | "friend_accept" | "group_invite" | "challenge_created" | "challenge_started" | "challenge_ended" | "challenge_passed";
```

- [ ] **Step 2: Write the failing test additions**

In `apps/mobile/app/__tests__/notifications.test.tsx`, add two rows to the `useNotifications` mock `data` array (a `challenge_ended` and a `challenge_passed`), and add assertions:
```typescript
      { id: "n3", type: "challenge_ended", actor_id: "u4", actor_name: "Cara", entity_id: "c9", read: true, created_at: "2026-07-24T00:00:00Z" },
      { id: "n4", type: "challenge_passed", actor_id: "u5", actor_name: "Dan", entity_id: "c9", read: false, created_at: "2026-07-23T00:00:00Z" },
```
```typescript
test("renders challenge time-event messages", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  expect(getByText("Cara won a challenge")).toBeTruthy();
  expect(getByText("Dan passed you in a challenge")).toBeTruthy();
});

test("challenge_passed deep-links to the challenge", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  await fireEvent.press(getByText("Dan passed you in a challenge"));
  expect(mockPush).toHaveBeenCalledWith("/challenge/c9");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci notifications.test`
Expected: FAIL — the new message strings aren't produced yet (rows fall through to the default).

- [ ] **Step 4: Add the message + deep-link cases**

In `apps/mobile/app/notifications.tsx`, in `message()` add before `default`:
```typescript
    case "challenge_started":
      return "A challenge you joined has started";
    case "challenge_ended":
      return `${n.actor_name} won a challenge`;
    case "challenge_passed":
      return `${n.actor_name} passed you in a challenge`;
```
In `targetFor()` add before `default` (grouping with the existing challenge case):
```typescript
    case "challenge_started":
    case "challenge_ended":
    case "challenge_passed":
      return n.entity_id ? (`/challenge/${n.entity_id}` as Href) : null;
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; whole suite green (notifications test now covers the three new types).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/app/notifications.tsx apps/mobile/app/__tests__/notifications.test.tsx
git commit -m "feat(mobile): render challenge started/ended/passed notifications"
```

---

## After the tasks

Run the **final whole-branch review on opus** over `main..HEAD`, focused on: (1) idempotency (notify-then-mark; started/ended fire once; a notify failure doesn't mark); (2) the pass-detection logic (fires only on a worsening rank, correct "ahead" actor `st[i-1]`, no notify on first-seen, baseline always written); (3) `Standings` refactor is behavior-preserving for `Detail`; (4) the scheduler never crashes the API (tick/per-challenge errors logged, loop continues) and is cancelled on shutdown; (5) participant-only recipients; (6) the loc approximation is contained. Fold any Critical/Important before proposing the FF-merge to `main` (user-directed). Then a controller live-smoke: force a challenge's dates to trigger started/ended and drive a rank change for passed.

## Self-Review notes (author)

- **Spec coverage:** migration + schedule columns + repo queries (T1); `Standings` extraction (T2); three notification writers + types (T3); scheduler package + Tick (T4); main.go wiring + config (T5); mobile messages (T6). Idempotency covered by T4 `TestTickStartedNotifyErrorDoesNotMark` + `TestTickStartedNotifiesAndMarks`; pass logic by `TestTickPassed*`; behavior-preserving refactor by existing Detail tests staying green.
- **Type consistency:** `challengeData`/`standingsSource`/`notifier` port method sets exactly match `challenges.Repository` (T1), `challenges.Service.Standings` (T2), and `notifications.Service` (T3) — compile-checked by the `main.go` wiring (T5) and the scheduler stubs (T4). Mobile `NotificationType` values match the Go type strings.
- **Known accepted tradeoffs (flag at final review, not blockers):** the scheduler scores in a fixed app-default loc (may diverge from per-viewer `Detail` at day boundaries); a same-day-start challenge fires both `challenge_created` and `challenge_started`; `SetLastRanks` writes one row per participant per active-challenge tick (fine at expected scale).
