# Competitions (Social D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time-boxed group challenges — a group member creates a challenge with a metric and a duration preset, members opt in, participants are ranked by a windowed score, and the top standing wins when the window closes.

**Architecture:** New `internal/challenges` package (model/repository/service/handler) mirroring `internal/groups`, plus a new `progress.WindowScore` that reuses `foodlog.DailyKcal` exactly like `progress.Compute`. Challenge standings are participant-only (opt-in = consent) so they compute every participant's score directly — they do NOT route through `compare.ProgressForMembers`. Mobile adds types + hooks, a Challenges section in the existing group-detail screen with a create sheet, and a new challenge-detail screen.

**Tech Stack:** Go 1.26 + Gin + GORM + Postgres (backend); Expo SDK 57 / React Native + React Query + expo-router (mobile).

## Global Constraints

- **No fabricated nutrition (hard invariant):** every kcal is row-sourced. `WindowScore` reads only `foodlog.DailyKcal` aggregates — no new kcal source, no derived/LLM number.
- **Membership-gated:** every challenge read/write requires membership of the challenge's group; 403 otherwise, enforced server-side before any payload.
- **Opt-in = consent:** standings show every *participant's* score regardless of their global `share_progress`; a group member who did not join never appears. Do NOT use `compare.ProgressForMembers` for standings.
- **GORM zero-time gotcha:** bare `time.Time` timestamp fields that rely on a SQL `DEFAULT now()` MUST be tagged `gorm:"autoCreateTime"`, or GORM inserts the Go zero time and overrides the default.
- **Status/winner are computed at read time from dates** (never stored); winner only when `ended` and ≥1 participant.
- **Conventional single-line commits, no signature.** Backend DB tests run against `kora_test`: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`. Apply new migrations to `kora_test` first with `go run ./cmd/migrate`. Run tests **FOREGROUND**. Stale RED Go LSP diagnostics after a test-before-impl task are always stale — verify with `go build ./...` / `go test`, not the LSP.
- **Mobile:** `npx tsc --noEmit` + `npm test -- --ci`; no `console.log`; no `any`; `Button` variants are `primary|secondary|ghost`; dynamic routes use `router.push(path as Href)`; jest.mock factories reference only `mock`-prefixed vars; conditional-mount sheets to avoid touching sibling test mocks.

---

### Task 1: Migration `000012` + `challenges` model + repository

**Files:**
- Create: `api/internal/database/migrations/000012_challenges.up.sql`
- Create: `api/internal/database/migrations/000012_challenges.down.sql`
- Create: `api/internal/challenges/model.go`
- Create: `api/internal/challenges/errors.go`
- Create: `api/internal/challenges/repository.go`
- Test: `api/internal/challenges/repository_test.go`

**Interfaces:**
- Consumes: `users(id)`, `groups(id)` tables (existing); `uuid.UUID`; GORM.
- Produces (later tasks rely on these exact names/types):
  - `challenges.Metric` (`string`), consts `MetricOnTarget = "on_target"`, `MetricLogged = "logged"`, `ValidMetric(string) bool`.
  - `challenges.Challenge{ID, GroupID, CreatorID uuid.UUID; Title string; Metric Metric; StartDate, EndDate, CreatedAt time.Time}`.
  - `challenges.ChallengeParticipant{ChallengeID, UserID uuid.UUID; JoinedAt time.Time}`.
  - `challenges.ChallengeSummary{ID uuid.UUID; Title string; Metric Metric; Status string; StartDate, EndDate time.Time; ParticipantCount int; Joined bool}`.
  - `challenges.ScoringRow{ID uuid.UUID; DisplayName string; TargetKcal float64}`.
  - `challenges.Standing{UserID uuid.UUID; DisplayName string; Score int}`.
  - `challenges.ChallengeDetail{ID uuid.UUID; Title string; Metric Metric; Status string; StartDate, EndDate time.Time; Joined, CanDelete bool; Standings []Standing; Winner *Standing}`.
  - Status consts `StatusUpcoming = "upcoming"`, `StatusActive = "active"`, `StatusEnded = "ended"`; `Status(start, end, now time.Time, loc *time.Location) string`; `var durationDays = map[string]int{"1w":7,"2w":14,"1mo":30}`.
  - `challenges.Repository` with `NewRepository(db) Repository` and methods: `Create(ctx, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error)`, `FindByID(ctx, id) (*Challenge, error)`, `ListForGroup(ctx, groupID, viewerID uuid.UUID) ([]ChallengeSummary, error)`, `AddParticipant(ctx, challengeID, userID) error`, `RemoveParticipant(ctx, challengeID, userID) error`, `IsParticipant(ctx, challengeID, userID) (bool, error)`, `ListParticipantsForScoring(ctx, challengeID) ([]ScoringRow, error)`, `Delete(ctx, challengeID) error`.
  - Sentinel errors: `ErrNotFound`, `ErrForbidden`, `ErrBadInput`.

- [ ] **Step 1: Write the migration up file**

`api/internal/database/migrations/000012_challenges.up.sql`:
```sql
CREATE TABLE challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    metric TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_challenges_group ON challenges (group_id);
CREATE TABLE challenge_participants (
    challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (challenge_id, user_id)
);
```

- [ ] **Step 2: Write the migration down file**

`api/internal/database/migrations/000012_challenges.down.sql`:
```sql
DROP TABLE IF EXISTS challenge_participants;
DROP TABLE IF EXISTS challenges;
```

- [ ] **Step 3: Apply the migration to `kora_test`**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`
Expected: migrates to version 12 with no error (log shows the applied migration; re-running is a no-op).

- [ ] **Step 4: Write `model.go`**

`api/internal/challenges/model.go`:
```go
// Package challenges owns time-boxed group challenges and their participants.
package challenges

import (
	"time"

	"github.com/google/uuid"
)

type Metric string

const (
	MetricOnTarget Metric = "on_target"
	MetricLogged   Metric = "logged"
)

func ValidMetric(m string) bool {
	return m == string(MetricOnTarget) || m == string(MetricLogged)
}

const (
	StatusUpcoming = "upcoming"
	StatusActive   = "active"
	StatusEnded    = "ended"
)

// durationDays maps a preset to the number of days added to today for end_date.
var durationDays = map[string]int{"1w": 7, "2w": 14, "1mo": 30}

type Challenge struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	GroupID   uuid.UUID `json:"group_id"`
	CreatorID uuid.UUID `json:"creator_id"`
	Title     string    `json:"title"`
	Metric    Metric    `json:"metric"`
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
}

type ChallengeParticipant struct {
	ChallengeID uuid.UUID `gorm:"primaryKey" json:"challenge_id"`
	UserID      uuid.UUID `gorm:"primaryKey" json:"user_id"`
	JoinedAt    time.Time `gorm:"autoCreateTime" json:"joined_at"`
}

// ChallengeSummary is a list row within a group. Status is filled by the service
// (computed from dates), not by SQL.
type ChallengeSummary struct {
	ID               uuid.UUID `json:"id"`
	Title            string    `json:"title"`
	Metric           Metric    `json:"metric"`
	Status           string    `json:"status"`
	StartDate        time.Time `json:"start_date"`
	EndDate          time.Time `json:"end_date"`
	ParticipantCount int       `json:"participant_count"`
	Joined           bool      `json:"joined"`
}

// ScoringRow is one participant's minimal input to WindowScore.
type ScoringRow struct {
	ID          uuid.UUID
	DisplayName string
	TargetKcal  float64
}

type Standing struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Score       int       `json:"score"`
}

type ChallengeDetail struct {
	ID        uuid.UUID  `json:"id"`
	Title     string     `json:"title"`
	Metric    Metric     `json:"metric"`
	Status    string     `json:"status"`
	StartDate time.Time  `json:"start_date"`
	EndDate   time.Time  `json:"end_date"`
	Joined    bool       `json:"joined"`
	CanDelete bool       `json:"can_delete"`
	Standings []Standing `json:"standings"`
	Winner    *Standing  `json:"winner,omitempty"`
}

// Status is computed from the calendar window vs the viewer's local "today".
// ISO date strings compare correctly lexicographically.
func Status(start, end, now time.Time, loc *time.Location) string {
	today := now.In(loc).Format("2006-01-02")
	s := start.Format("2006-01-02")
	e := end.Format("2006-01-02")
	switch {
	case today < s:
		return StatusUpcoming
	case today > e:
		return StatusEnded
	default:
		return StatusActive
	}
}
```

- [ ] **Step 5: Write `errors.go`**

`api/internal/challenges/errors.go`:
```go
package challenges

import "errors"

var (
	ErrNotFound  = errors.New("challenge not found")
	ErrForbidden = errors.New("not allowed")
	ErrBadInput  = errors.New("invalid input")
)
```

- [ ] **Step 6: Write the failing repository test**

`api/internal/challenges/repository_test.go`:
```go
package challenges

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func seedUser(t *testing.T, db *gorm.DB, name string, targetKcal float64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name, target_kcal) VALUES (?, ?, ?, ?, ?)",
		id, "ch-"+id.String(), "ch-"+id.String()+"@test.dev", name, targetKcal).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM challenge_participants WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func seedGroup(t *testing.T, db *gorm.DB, owner uuid.UUID) uuid.UUID {
	t.Helper()
	gid := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO groups (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)",
		gid, "Squad", owner, "CH"+gid.String()[:6]).Error)
	require.NoError(t, db.Exec("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')", gid, owner).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", gid) })
	return gid
}

func TestCreateAutoJoinsCreatorAndSetsJoinedAt(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)

	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 7)
	ch, err := repo.Create(context.Background(), gid, owner, "July streak", MetricLogged, start, end)
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, ch.ID)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })

	// creator auto-joined with a real joined_at (not the Go zero time)
	var p ChallengeParticipant
	require.NoError(t, db.Where("challenge_id = ? AND user_id = ?", ch.ID, owner).First(&p).Error)
	require.False(t, p.JoinedAt.IsZero(), "joined_at should be populated, not the Go zero time")

	isP, err := repo.IsParticipant(context.Background(), ch.ID, owner)
	require.NoError(t, err)
	require.True(t, isP)
}

func TestListForGroupCountsParticipantsAndViewerJoined(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	other := seedUser(t, db, "Other", 1800)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "July streak", MetricOnTarget, start, start.AddDate(0, 0, 14))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))
	// idempotent
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))

	// viewer = owner -> joined true, count 2
	summaries, err := repo.ListForGroup(context.Background(), gid, owner)
	require.NoError(t, err)
	require.Len(t, summaries, 1)
	require.Equal(t, "July streak", summaries[0].Title)
	require.Equal(t, MetricOnTarget, summaries[0].Metric)
	require.Equal(t, 2, summaries[0].ParticipantCount)
	require.True(t, summaries[0].Joined)

	// scoring rows include target_kcal for every participant
	rows, err := repo.ListParticipantsForScoring(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Len(t, rows, 2)

	// leave removes participation
	require.NoError(t, repo.RemoveParticipant(context.Background(), ch.ID, other))
	isP, err := repo.IsParticipant(context.Background(), ch.ID, other)
	require.NoError(t, err)
	require.False(t, isP)
}

func TestDeleteCascadesParticipants(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Gone soon", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	require.NoError(t, repo.Delete(context.Background(), ch.ID))
	got, err := repo.FindByID(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Nil(t, got)
	var count int64
	require.NoError(t, db.Model(&ChallengeParticipant{}).Where("challenge_id = ?", ch.ID).Count(&count).Error)
	require.Equal(t, int64(0), count)
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/`
Expected: FAIL / build error — `NewRepository` and repo methods undefined.

- [ ] **Step 8: Write `repository.go`**

`api/internal/challenges/repository.go`:
```go
package challenges

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error) {
	ch := Challenge{GroupID: groupID, CreatorID: creatorID, Title: title, Metric: metric, StartDate: start, EndDate: end}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&ch).Error; err != nil {
			return err
		}
		return tx.Create(&ChallengeParticipant{ChallengeID: ch.ID, UserID: creatorID}).Error
	})
	if err != nil {
		return Challenge{}, fmt.Errorf("challenges: create: %w", err)
	}
	return ch, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Challenge, error) {
	var ch Challenge
	err := r.db.WithContext(ctx).First(&ch, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("challenges: find by id: %w", err)
	}
	return &ch, nil
}

func (r Repository) ListForGroup(ctx context.Context, groupID, viewerID uuid.UUID) ([]ChallengeSummary, error) {
	out := []ChallengeSummary{}
	err := r.db.WithContext(ctx).
		Table("challenges AS c").
		Select("c.id AS id, c.title AS title, c.metric AS metric, c.start_date AS start_date, c.end_date AS end_date, "+
			"(SELECT count(*) FROM challenge_participants p WHERE p.challenge_id = c.id) AS participant_count, "+
			"EXISTS(SELECT 1 FROM challenge_participants p2 WHERE p2.challenge_id = c.id AND p2.user_id = ?) AS joined", viewerID).
		Where("c.group_id = ?", groupID).
		Order("c.created_at DESC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list for group: %w", err)
	}
	return out, nil
}

func (r Repository) AddParticipant(ctx context.Context, challengeID, userID uuid.UUID) error {
	p := ChallengeParticipant{ChallengeID: challengeID, UserID: userID}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&p).Error
	if err != nil {
		return fmt.Errorf("challenges: add participant: %w", err)
	}
	return nil
}

func (r Repository) RemoveParticipant(ctx context.Context, challengeID, userID uuid.UUID) error {
	if err := r.db.WithContext(ctx).
		Where("challenge_id = ? AND user_id = ?", challengeID, userID).
		Delete(&ChallengeParticipant{}).Error; err != nil {
		return fmt.Errorf("challenges: remove participant: %w", err)
	}
	return nil
}

func (r Repository) IsParticipant(ctx context.Context, challengeID, userID uuid.UUID) (bool, error) {
	var count int64
	if err := r.db.WithContext(ctx).Model(&ChallengeParticipant{}).
		Where("challenge_id = ? AND user_id = ?", challengeID, userID).
		Count(&count).Error; err != nil {
		return false, fmt.Errorf("challenges: is participant: %w", err)
	}
	return count > 0, nil
}

func (r Repository) ListParticipantsForScoring(ctx context.Context, challengeID uuid.UUID) ([]ScoringRow, error) {
	out := []ScoringRow{}
	err := r.db.WithContext(ctx).
		Table("challenge_participants AS p").
		Select("u.id AS id, u.display_name AS display_name, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = p.user_id").
		Where("p.challenge_id = ?", challengeID).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list participants for scoring: %w", err)
	}
	return out, nil
}

func (r Repository) Delete(ctx context.Context, challengeID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Challenge{}, "id = ?", challengeID).Error; err != nil {
		return fmt.Errorf("challenges: delete: %w", err)
	}
	return nil
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/`
Expected: PASS (3 tests). Also run `cd api && go build ./...` — clean. (Ignore any stale RED LSP diagnostics.)

- [ ] **Step 10: Commit**

```bash
git add api/internal/database/migrations/000012_challenges.up.sql api/internal/database/migrations/000012_challenges.down.sql api/internal/challenges/
git commit -m "feat(challenges): migration 000012 + model + repository"
```

---

### Task 2: `progress.WindowScore`

**Files:**
- Modify: `api/internal/progress/progress.go`
- Test: `api/internal/progress/window_test.go`

**Interfaces:**
- Consumes: existing `progress.LogSource` interface (`DailyKcal`), `adherenceBand` const.
- Produces: `progress.WindowScore(ctx context.Context, logs LogSource, userID uuid.UUID, metric string, targetKcal float64, from, to time.Time, loc *time.Location) (int, error)` — `metric` is `"logged"` or `"on_target"`; `from`/`to` are the challenge's start/end dates (inclusive); unknown metric → error.

- [ ] **Step 1: Write the failing test**

`api/internal/progress/window_test.go`:
```go
package progress

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestWindowScoreLoggedCountsDistinctDays(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{
		"2026-07-01": 1500, "2026-07-03": 2000, "2026-07-07": 1800,
	}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "logged", 2000, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 3, n)
}

func TestWindowScoreOnTargetInclusiveBand(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{
		"2026-07-01": 2000, // exactly on target -> in
		"2026-07-02": 2200, // +10% exactly -> in (<=)
		"2026-07-03": 2201, // just over +10% -> out
		"2026-07-04": 1500, // under -> out
	}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "on_target", 2000, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 2, n)
}

func TestWindowScoreZeroTargetIsZero(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{"2026-07-01": 1500, "2026-07-02": 1600}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "on_target", 0, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 0, n)
}

func TestWindowScoreUnknownMetricErrors(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	_, err := WindowScore(context.Background(), stubLogs{}, uuid.New(), "bogus", 2000, from, from, loc)
	require.Error(t, err)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/progress/ -run TestWindowScore -v`
Expected: FAIL — `WindowScore` undefined.

- [ ] **Step 3: Add `WindowScore` to `progress.go`**

Add these imports if missing (`fmt` is new) and append the function to `api/internal/progress/progress.go`:
```go
// WindowScore counts, over the inclusive local-day window [from, to], either
// distinct logged days ("logged") or on-target days ("on_target": kcal within
// ±10% of targetKcal). It reads only DailyKcal aggregates, so no fabricated
// nutrition can enter the score. from/to are calendar dates (the challenge
// window); their Y/M/D are re-anchored to loc.
func WindowScore(ctx context.Context, logs LogSource, userID uuid.UUID, metric string, targetKcal float64, from, to time.Time, loc *time.Location) (int, error) {
	startLocal := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc)
	endLocal := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc)
	kcalByDay, err := logs.DailyKcal(ctx, userID, startLocal, endLocal.AddDate(0, 0, 1), loc)
	if err != nil {
		return 0, err
	}
	switch metric {
	case "logged":
		return len(kcalByDay), nil
	case "on_target":
		count := 0
		if targetKcal > 0 {
			for d := startLocal; !d.After(endLocal); d = d.AddDate(0, 0, 1) {
				key := d.Format("2006-01-02")
				if math.Abs(kcalByDay[key]-targetKcal) <= adherenceBand*targetKcal {
					count++
				}
			}
		}
		return count, nil
	default:
		return 0, fmt.Errorf("progress: unknown metric %q", metric)
	}
}
```

Add `"fmt"` to the import block (keep `"math"`, `"time"`, `"context"`, `uuid` already present).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && go test ./internal/progress/ -run TestWindowScore -v && go test ./internal/progress/`
Expected: PASS (4 new + existing Compute tests). `cd api && go build ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/progress/progress.go api/internal/progress/window_test.go
git commit -m "feat(progress): WindowScore over an arbitrary date window (both metrics)"
```

---

### Task 3: `challenges` service (create / list / join / leave / detail / delete)

**Files:**
- Create: `api/internal/challenges/service.go`
- Test: `api/internal/challenges/service_test.go`

**Interfaces:**
- Consumes: `challenges.Repository` (via `challengeStore` interface), `groups.Role`/`groups.RoleOwner` + `groups.Repository` (via `groupAccess` interface), `progress.LogSource` + `progress.WindowScore`, `durationDays`, `ValidMetric`, `Status`, the view types from Task 1.
- Produces:
  - `challenges.Service` with `NewService(repo challengeStore, groups groupAccess, logs progress.LogSource) Service`.
  - `Create(ctx, userID, groupID uuid.UUID, title string, metric Metric, duration string, now time.Time) (Challenge, error)`.
  - `List(ctx, userID, groupID uuid.UUID, now time.Time, loc *time.Location) ([]ChallengeSummary, error)`.
  - `Join(ctx, userID, challengeID uuid.UUID) error`, `Leave(ctx, userID, challengeID uuid.UUID) error`.
  - `Detail(ctx, userID, challengeID uuid.UUID, now time.Time, loc *time.Location) (ChallengeDetail, error)`.
  - `Delete(ctx, userID, challengeID uuid.UUID) error`.
  - Interfaces `challengeStore` (all `Repository` methods) and `groupAccess` (`IsMember`, `RoleOf`).

- [ ] **Step 1: Write the failing service test**

`api/internal/challenges/service_test.go`:
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

// --- in-memory stubs (no DB) ---

type memberRole struct {
	member bool
	role   groups.Role
	ok     bool
}

type stubGroups struct {
	m map[[2]uuid.UUID]memberRole // key: {groupID, userID}
}

func (s stubGroups) IsMember(_ context.Context, g, u uuid.UUID) (bool, error) {
	return s.m[[2]uuid.UUID{g, u}].member, nil
}
func (s stubGroups) RoleOf(_ context.Context, g, u uuid.UUID) (groups.Role, bool, error) {
	mr := s.m[[2]uuid.UUID{g, u}]
	return mr.role, mr.ok, nil
}

type stubStore struct {
	created      *Challenge
	participants map[uuid.UUID]map[uuid.UUID]bool // challengeID -> set of userIDs
	scoring      []ScoringRow
	find         *Challenge
	deleted      bool
}

func newStubStore() *stubStore {
	return &stubStore{participants: map[uuid.UUID]map[uuid.UUID]bool{}}
}
func (s *stubStore) Create(_ context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error) {
	ch := Challenge{ID: uuid.New(), GroupID: groupID, CreatorID: creatorID, Title: title, Metric: metric, StartDate: start, EndDate: end}
	s.created = &ch
	s.participants[ch.ID] = map[uuid.UUID]bool{creatorID: true}
	s.find = &ch
	return ch, nil
}
func (s *stubStore) FindByID(_ context.Context, id uuid.UUID) (*Challenge, error) {
	if s.find != nil && s.find.ID == id {
		return s.find, nil
	}
	return nil, nil
}
func (s *stubStore) ListForGroup(_ context.Context, _, _ uuid.UUID) ([]ChallengeSummary, error) {
	if s.find == nil {
		return []ChallengeSummary{}, nil
	}
	return []ChallengeSummary{{ID: s.find.ID, Title: s.find.Title, Metric: s.find.Metric, StartDate: s.find.StartDate, EndDate: s.find.EndDate, ParticipantCount: len(s.participants[s.find.ID])}}, nil
}
func (s *stubStore) AddParticipant(_ context.Context, cid, uid uuid.UUID) error {
	if s.participants[cid] == nil {
		s.participants[cid] = map[uuid.UUID]bool{}
	}
	s.participants[cid][uid] = true
	return nil
}
func (s *stubStore) RemoveParticipant(_ context.Context, cid, uid uuid.UUID) error {
	delete(s.participants[cid], uid)
	return nil
}
func (s *stubStore) IsParticipant(_ context.Context, cid, uid uuid.UUID) (bool, error) {
	return s.participants[cid][uid], nil
}
func (s *stubStore) ListParticipantsForScoring(_ context.Context, _ uuid.UUID) ([]ScoringRow, error) {
	return s.scoring, nil
}
func (s *stubStore) Delete(_ context.Context, _ uuid.UUID) error { s.deleted = true; return nil }

// DailyKcal-only stub for scoring.
type stubLogs struct{ kcal map[uuid.UUID]map[string]float64 }

func (s stubLogs) LoggedDaysDesc(_ context.Context, _ uuid.UUID, _ time.Time, _ *time.Location, _ int) ([]string, error) {
	return nil, nil
}
func (s stubLogs) DailyKcal(_ context.Context, u uuid.UUID, _, _ time.Time, _ *time.Location) (map[string]float64, error) {
	return s.kcal[u], nil
}

func member(g, u uuid.UUID, role groups.Role) map[[2]uuid.UUID]memberRole {
	return map[[2]uuid.UUID]memberRole{{g, u}: {member: true, role: role, ok: true}}
}

func TestCreateGatesNonMemberAndValidates(t *testing.T) {
	g, owner, stranger := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{})
	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC)

	// non-member cannot create
	_, err := svc.Create(context.Background(), stranger, g, "X", MetricLogged, "1w", now)
	require.ErrorIs(t, err, ErrForbidden)
	// blank title / bad metric / bad duration
	_, err = svc.Create(context.Background(), owner, g, "  ", MetricLogged, "1w", now)
	require.ErrorIs(t, err, ErrBadInput)
	_, err = svc.Create(context.Background(), owner, g, "X", Metric("bogus"), "1w", now)
	require.ErrorIs(t, err, ErrBadInput)
	_, err = svc.Create(context.Background(), owner, g, "X", MetricLogged, "5d", now)
	require.ErrorIs(t, err, ErrBadInput)

	// member creates -> auto-joined, end = today+7
	ch, err := svc.Create(context.Background(), owner, g, "Streak", MetricLogged, "1w", now)
	require.NoError(t, err)
	require.Equal(t, "Streak", ch.Title)
	require.Equal(t, "2026-07-26", ch.StartDate.Format("2006-01-02"))
	require.Equal(t, "2026-08-02", ch.EndDate.Format("2006-01-02"))
	isP, _ := store.IsParticipant(context.Background(), ch.ID, owner)
	require.True(t, isP)
}

func TestJoinLeaveGatedOnGroupMembership(t *testing.T) {
	g, owner, member2, stranger := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	groupsStub := stubGroups{m: map[[2]uuid.UUID]memberRole{
		{g, owner}:   {member: true, role: groups.RoleOwner, ok: true},
		{g, member2}: {member: true, role: groups.RoleMember, ok: true},
	}}
	svc := NewService(store, groupsStub, stubLogs{})
	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC)
	ch, _ := svc.Create(context.Background(), owner, g, "Streak", MetricLogged, "1w", now)

	require.ErrorIs(t, svc.Join(context.Background(), stranger, ch.ID), ErrForbidden)
	require.NoError(t, svc.Join(context.Background(), member2, ch.ID))
	require.NoError(t, svc.Join(context.Background(), member2, ch.ID)) // idempotent
	require.NoError(t, svc.Leave(context.Background(), member2, ch.ID))
	// unknown challenge -> 404
	require.ErrorIs(t, svc.Join(context.Background(), member2, uuid.New()), ErrNotFound)
}

func TestDetailStandingsSortAndWinner(t *testing.T) {
	g, owner, alice, bob := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{kcal: map[uuid.UUID]map[string]float64{
		alice: {"2026-07-01": 2000, "2026-07-02": 2000}, // 2 logged
		bob:   {"2026-07-01": 2000},                     // 1 logged
	}})
	// build an ended challenge directly in the stub
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: owner, Title: "Past", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 3)}
	store.find = &ch
	store.participants[ch.ID] = map[uuid.UUID]bool{alice: true, bob: true, owner: true}
	store.scoring = []ScoringRow{{ID: bob, DisplayName: "Bob", TargetKcal: 2000}, {ID: alice, DisplayName: "Alice", TargetKcal: 2000}}

	now := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC) // after end -> ended
	d, err := svc.Detail(context.Background(), owner, ch.ID, now, time.UTC)
	require.NoError(t, err)
	require.Equal(t, StatusEnded, d.Status)
	require.Len(t, d.Standings, 3)
	require.Equal(t, "Alice", d.Standings[0].DisplayName) // 2 > 1
	require.Equal(t, 2, d.Standings[0].Score)
	require.NotNil(t, d.Winner)
	require.Equal(t, "Alice", d.Winner.DisplayName)
	require.True(t, d.CanDelete) // owner is creator
}

func TestDetailActiveHasNoWinnerAndGatesNonMember(t *testing.T) {
	g, owner, stranger := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{})
	start := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: owner, Title: "Now", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 7)}
	store.find = &ch
	store.participants[ch.ID] = map[uuid.UUID]bool{owner: true}

	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC) // within window -> active
	d, err := svc.Detail(context.Background(), owner, ch.ID, now, time.UTC)
	require.NoError(t, err)
	require.Equal(t, StatusActive, d.Status)
	require.Nil(t, d.Winner)

	_, err = svc.Detail(context.Background(), stranger, ch.ID, now, time.UTC)
	require.ErrorIs(t, err, ErrForbidden)
}

func TestDeleteAllowsCreatorAndOwnerRejectsMember(t *testing.T) {
	g, owner, creator, plainMember := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	groupsStub := stubGroups{m: map[[2]uuid.UUID]memberRole{
		{g, owner}:       {member: true, role: groups.RoleOwner, ok: true},
		{g, creator}:     {member: true, role: groups.RoleMember, ok: true},
		{g, plainMember}: {member: true, role: groups.RoleMember, ok: true},
	}}
	svc := NewService(store, groupsStub, stubLogs{})
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: creator, Title: "X", Metric: MetricLogged}
	store.find = &ch

	// a plain member who is not the creator cannot delete
	require.ErrorIs(t, svc.Delete(context.Background(), plainMember, ch.ID), ErrForbidden)
	// the group owner can delete someone else's challenge
	require.NoError(t, svc.Delete(context.Background(), owner, ch.ID))
	// the creator can delete their own
	store.deleted = false
	require.NoError(t, svc.Delete(context.Background(), creator, ch.ID))
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/challenges/ -run 'TestCreate|TestJoin|TestDetail|TestDelete' -v`
Expected: FAIL / build error — `NewService`, `Service`, `challengeStore`, `groupAccess` undefined.

- [ ] **Step 3: Write `service.go`**

`api/internal/challenges/service.go`:
```go
package challenges

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/progress"
)

// challengeStore is the persistence surface the service needs (Repository satisfies it).
type challengeStore interface {
	Create(ctx context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error)
	FindByID(ctx context.Context, id uuid.UUID) (*Challenge, error)
	ListForGroup(ctx context.Context, groupID, viewerID uuid.UUID) ([]ChallengeSummary, error)
	AddParticipant(ctx context.Context, challengeID, userID uuid.UUID) error
	RemoveParticipant(ctx context.Context, challengeID, userID uuid.UUID) error
	IsParticipant(ctx context.Context, challengeID, userID uuid.UUID) (bool, error)
	ListParticipantsForScoring(ctx context.Context, challengeID uuid.UUID) ([]ScoringRow, error)
	Delete(ctx context.Context, challengeID uuid.UUID) error
}

// groupAccess is the membership/ownership surface (groups.Repository satisfies it).
type groupAccess interface {
	IsMember(ctx context.Context, groupID, userID uuid.UUID) (bool, error)
	RoleOf(ctx context.Context, groupID, userID uuid.UUID) (groups.Role, bool, error)
}

type Service struct {
	repo   challengeStore
	groups groupAccess
	logs   progress.LogSource
}

func NewService(repo challengeStore, groupAcc groupAccess, logs progress.LogSource) Service {
	return Service{repo: repo, groups: groupAcc, logs: logs}
}

func (s Service) Create(ctx context.Context, userID, groupID uuid.UUID, title string, metric Metric, duration string, now time.Time) (Challenge, error) {
	isM, err := s.groups.IsMember(ctx, groupID, userID)
	if err != nil {
		return Challenge{}, err
	}
	if !isM {
		return Challenge{}, ErrForbidden
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return Challenge{}, ErrBadInput
	}
	if !ValidMetric(string(metric)) {
		return Challenge{}, ErrBadInput
	}
	days, ok := durationDays[duration]
	if !ok {
		return Challenge{}, ErrBadInput
	}
	y, m, d := now.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, days)
	return s.repo.Create(ctx, groupID, userID, title, metric, start, end)
}

func (s Service) List(ctx context.Context, userID, groupID uuid.UUID, now time.Time, loc *time.Location) ([]ChallengeSummary, error) {
	isM, err := s.groups.IsMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if !isM {
		return nil, ErrForbidden
	}
	out, err := s.repo.ListForGroup(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Status = Status(out[i].StartDate, out[i].EndDate, now, loc)
	}
	return out, nil
}

func (s Service) Join(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return err
	}
	return s.repo.AddParticipant(ctx, ch.ID, userID)
}

func (s Service) Leave(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return err
	}
	return s.repo.RemoveParticipant(ctx, ch.ID, userID)
}

func (s Service) Detail(ctx context.Context, userID, challengeID uuid.UUID, now time.Time, loc *time.Location) (ChallengeDetail, error) {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	status := Status(ch.StartDate, ch.EndDate, now, loc)
	rows, err := s.repo.ListParticipantsForScoring(ctx, ch.ID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	standings := make([]Standing, 0, len(rows))
	for _, r := range rows {
		score, err := progress.WindowScore(ctx, s.logs, r.ID, string(ch.Metric), r.TargetKcal, ch.StartDate, ch.EndDate, loc)
		if err != nil {
			return ChallengeDetail{}, err
		}
		standings = append(standings, Standing{UserID: r.ID, DisplayName: r.DisplayName, Score: score})
	}
	sort.SliceStable(standings, func(i, j int) bool {
		if standings[i].Score != standings[j].Score {
			return standings[i].Score > standings[j].Score
		}
		return standings[i].DisplayName < standings[j].DisplayName
	})
	joined, err := s.repo.IsParticipant(ctx, ch.ID, userID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	owner, err := s.isGroupOwner(ctx, ch.GroupID, userID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	var winner *Standing
	if status == StatusEnded && len(standings) > 0 {
		w := standings[0]
		winner = &w
	}
	return ChallengeDetail{
		ID: ch.ID, Title: ch.Title, Metric: ch.Metric, Status: status,
		StartDate: ch.StartDate, EndDate: ch.EndDate,
		Joined: joined, CanDelete: userID == ch.CreatorID || owner,
		Standings: standings, Winner: winner,
	}, nil
}

func (s Service) Delete(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.repo.FindByID(ctx, challengeID)
	if err != nil {
		return err
	}
	if ch == nil {
		return ErrNotFound
	}
	if userID != ch.CreatorID {
		owner, err := s.isGroupOwner(ctx, ch.GroupID, userID)
		if err != nil {
			return err
		}
		if !owner {
			return ErrForbidden
		}
	}
	return s.repo.Delete(ctx, ch.ID)
}

// mustMember resolves a challenge and asserts the user is a member of its group.
func (s Service) mustMember(ctx context.Context, userID, challengeID uuid.UUID) (*Challenge, error) {
	ch, err := s.repo.FindByID(ctx, challengeID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, ErrNotFound
	}
	isM, err := s.groups.IsMember(ctx, ch.GroupID, userID)
	if err != nil {
		return nil, err
	}
	if !isM {
		return nil, ErrForbidden
	}
	return ch, nil
}

func (s Service) isGroupOwner(ctx context.Context, groupID, userID uuid.UUID) (bool, error) {
	role, ok, err := s.groups.RoleOf(ctx, groupID, userID)
	if err != nil {
		return false, err
	}
	return ok && role == groups.RoleOwner, nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && go test ./internal/challenges/ -run 'TestCreate|TestJoin|TestDetail|TestDelete' -v`
Expected: PASS. Then the whole package with DB: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/` — PASS. `go build ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/challenges/service.go api/internal/challenges/service_test.go
git commit -m "feat(challenges): service with membership gates, standings, status/winner"
```

---

### Task 4: `challenges` handlers + routes + wiring

**Files:**
- Create: `api/internal/challenges/handler.go`
- Test: `api/internal/challenges/handler_test.go`
- Modify: `api/internal/server/router.go`

**Interfaces:**
- Consumes: `challenges.Service`, `user.IDFromContext`, `user.LocFromContext`, `httpx.OK`/`httpx.Error`, gin.
- Produces: `challenges.Handler` with `NewHandler(svc Service) Handler` and methods `Create`, `List`, `Join`, `Leave`, `Detail`, `Delete`. Routes mounted in `router.go` under authed `/v1`.

- [ ] **Step 1: Write `handler.go`**

`api/internal/challenges/handler.go`:
```go
package challenges

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) parseID(c *gin.Context, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(param))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

func mapErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrBadInput):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid input")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "challenge not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

type createBody struct {
	Title    string `json:"title"`
	Metric   string `json:"metric"`
	Duration string `json:"duration"`
}

func (h Handler) Create(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req createBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	now := time.Now().In(user.LocFromContext(c))
	ch, err := h.svc.Create(c.Request.Context(), uid, gid, req.Title, Metric(req.Metric), req.Duration, now)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": ch})
}

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	items, err := h.svc.List(c.Request.Context(), uid, gid, time.Now(), user.LocFromContext(c))
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, items)
}

func (h Handler) Join(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Join(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"joined": true})
}

func (h Handler) Leave(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Leave(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"left": true})
}

func (h Handler) Detail(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	d, err := h.svc.Detail(c.Request.Context(), uid, cid, time.Now(), user.LocFromContext(c))
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, d)
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	cid, ok := h.parseID(c, "cid")
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), uid, cid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
```

- [ ] **Step 2: Write the failing handler test**

`api/internal/challenges/handler_test.go`:
```go
package challenges

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	repo := NewRepository(db)
	svc := NewService(repo, groups.NewRepository(db), foodlog.NewRepository(db))
	h := NewHandler(svc)
	r.POST("/v1/groups/:id/challenges", h.Create)
	r.GET("/v1/groups/:id/challenges", h.List)
	r.POST("/v1/challenges/:cid/join", h.Join)
	r.DELETE("/v1/challenges/:cid/join", h.Leave)
	r.GET("/v1/challenges/:cid", h.Detail)
	r.DELETE("/v1/challenges/:cid", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestCreateChallengeMemberVsNonMember(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	// owner (a member) can create
	rOwner := mountFor(owner, db)
	w := doJSON(rOwner, http.MethodPost, "/v1/groups/"+gid.String()+"/challenges", `{"title":"Streak","metric":"logged","duration":"1w"}`)
	require.Equal(t, http.StatusCreated, w.Code)

	// a stranger cannot create
	rStranger := mountFor(stranger, db)
	w2 := doJSON(rStranger, http.MethodPost, "/v1/groups/"+gid.String()+"/challenges", `{"title":"X","metric":"logged","duration":"1w"}`)
	require.Equal(t, http.StatusForbidden, w2.Code)
}

func TestDetailAndDeleteGating(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	memberU := seedUser(t, db, "Member", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	require.NoError(t, db.Exec("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')", gid, memberU).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	repo := NewRepository(db)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Streak", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	// stranger cannot view detail
	rStranger := mountFor(stranger, db)
	require.Equal(t, http.StatusForbidden, doJSON(rStranger, http.MethodGet, "/v1/challenges/"+ch.ID.String(), "").Code)

	// a plain member cannot delete someone else's challenge
	rMember := mountFor(memberU, db)
	require.Equal(t, http.StatusForbidden, doJSON(rMember, http.MethodDelete, "/v1/challenges/"+ch.ID.String(), "").Code)

	// the creator (owner) can view and delete
	rOwner := mountFor(owner, db)
	require.Equal(t, http.StatusOK, doJSON(rOwner, http.MethodGet, "/v1/challenges/"+ch.ID.String(), "").Code)
	require.Equal(t, http.StatusOK, doJSON(rOwner, http.MethodDelete, "/v1/challenges/"+ch.ID.String(), "").Code)
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/challenges/ -run 'TestCreateChallenge|TestDetailAndDelete' -v`
Expected: initially FAIL if handler not yet compiling; once `handler.go` exists it should pass. (If you wrote handler.go in Step 1, this step confirms the tests pass; if practising strict TDD, stub `NewHandler` to return 500s first — optional.)

- [ ] **Step 4: Wire the routes in `router.go`**

In `api/internal/server/router.go`, add the import `"github.com/tesserix/kora/api/internal/challenges"` (keep imports sorted), and immediately AFTER the groups routes block (after the `v1.DELETE("/groups/:id", groupsHandler.Delete)` line) insert:
```go
			challengesRepo := challenges.NewRepository(deps.DB)
			challengesHandler := challenges.NewHandler(challenges.NewService(challengesRepo, groupsRepo, logRepo))
			v1.POST("/groups/:id/challenges", challengesHandler.Create)
			v1.GET("/groups/:id/challenges", challengesHandler.List)
			v1.POST("/challenges/:cid/join", challengesHandler.Join)
			v1.DELETE("/challenges/:cid/join", challengesHandler.Leave)
			v1.GET("/challenges/:cid", challengesHandler.Detail)
			v1.DELETE("/challenges/:cid", challengesHandler.Delete)
```
(`groupsRepo` and `logRepo` are already in scope from the groups/foodlog blocks above.)

- [ ] **Step 5: Run the full backend suite**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`
Expected: all packages PASS (challenges + server + unaffected packages). `go build ./...` and `go vet ./...` clean.

- [ ] **Step 6: Commit**

```bash
git add api/internal/challenges/handler.go api/internal/challenges/handler_test.go api/internal/server/router.go
git commit -m "feat(challenges): HTTP handlers + six /v1 routes wired, membership-gated"
```

---

### Task 5: Mobile types + challenge hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, React Query.
- Produces: types `Metric`, `ChallengeStatus`, `ChallengeSummary`, `ChallengeStanding`, `ChallengeDetail`; hooks `useGroupChallenges(groupId)`, `useChallenge(cid)`, `useCreateChallenge()`, `useJoinChallenge()`, `useLeaveChallenge()`, `useDeleteChallenge()`.

- [ ] **Step 1: Add types**

Append to `apps/mobile/src/api/types.ts`:
```typescript
export type Metric = "on_target" | "logged";
export type ChallengeStatus = "upcoming" | "active" | "ended";

export interface ChallengeSummary {
  id: string;
  title: string;
  metric: Metric;
  status: ChallengeStatus;
  start_date: string;
  end_date: string;
  participant_count: number;
  joined: boolean;
}

export interface ChallengeStanding {
  user_id: string;
  display_name: string;
  score: number;
}

export interface ChallengeDetail {
  id: string;
  title: string;
  metric: Metric;
  status: ChallengeStatus;
  start_date: string;
  end_date: string;
  joined: boolean;
  can_delete: boolean;
  standings: ChallengeStanding[];
  winner?: ChallengeStanding;
}
```

- [ ] **Step 2: Write the failing hook tests**

In `apps/mobile/src/api/__tests__/hooks.test.tsx`, add the new hooks to the existing import from `../hooks` (e.g. `useCreateChallenge`, `useJoinChallenge`, `useLeaveChallenge`, `useDeleteChallenge`, `useGroupChallenges`) and append:
```typescript
test("useGroupChallenges fetches /v1/groups/:id/challenges", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useGroupChallenges("g1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/challenges");
});

test("useCreateChallenge POSTs title/metric/duration", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "c1" });
  const { result } = await renderHook(() => useCreateChallenge(), { wrapper });
  result.current.mutate({ groupId: "g1", title: "Streak", metric: "logged", duration: "1w" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/challenges", {
    method: "POST",
    body: JSON.stringify({ title: "Streak", metric: "logged", duration: "1w" }),
  });
});

test("useJoinChallenge POSTs to /v1/challenges/:cid/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ joined: true });
  const { result } = await renderHook(() => useJoinChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1/join", { method: "POST" });
});

test("useLeaveChallenge DELETEs /v1/challenges/:cid/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ left: true });
  const { result } = await renderHook(() => useLeaveChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1/join", { method: "DELETE" });
});

test("useDeleteChallenge DELETEs /v1/challenges/:cid", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ deleted: true });
  const { result } = await renderHook(() => useDeleteChallenge(), { wrapper });
  result.current.mutate({ challengeId: "c1", groupId: "g1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/challenges/c1", { method: "DELETE" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/mobile && npm test -- --ci -t "Challenge"`
Expected: FAIL — the hooks are not exported yet.

- [ ] **Step 4: Add the hooks**

In `apps/mobile/src/api/hooks.ts`, add `ChallengeDetail`, `ChallengeSummary`, `Metric` to the `import type { ... } from "./types"` block (keep alphabetical), and append after the groups hooks:
```typescript
export function useGroupChallenges(groupId: string) {
  return useQuery({
    queryKey: ["group-challenges", groupId],
    queryFn: () => apiFetch(`/v1/groups/${groupId}/challenges`) as Promise<ChallengeSummary[]>,
    enabled: !!groupId,
  });
}

export function useChallenge(cid: string) {
  return useQuery({
    queryKey: ["challenge", cid],
    queryFn: () => apiFetch(`/v1/challenges/${cid}`) as Promise<ChallengeDetail>,
    enabled: !!cid,
  });
}

export function useCreateChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, title, metric, duration }: { groupId: string; title: string; metric: Metric; duration: string }) =>
      apiFetch(`/v1/groups/${groupId}/challenges`, { method: "POST", body: JSON.stringify({ title, metric, duration }) }) as Promise<ChallengeSummary>,
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}

export function useJoinChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "POST" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useLeaveChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}/join`, { method: "DELETE" }),
    onSuccess: (_d, { challengeId, groupId }) => {
      qc.invalidateQueries({ queryKey: ["challenge", challengeId] });
      qc.invalidateQueries({ queryKey: ["group-challenges", groupId] });
    },
  });
}

export function useDeleteChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ challengeId }: { challengeId: string; groupId: string }) =>
      apiFetch(`/v1/challenges/${challengeId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group-challenges", groupId] }),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci -t "Challenge"`
Expected: tsc clean; 5 new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): challenge types + hooks"
```

---

### Task 6: Challenges section in group detail + `CreateChallengeSheet`

**Files:**
- Create: `apps/mobile/src/components/social/CreateChallengeSheet.tsx`
- Modify: `apps/mobile/app/group/[id].tsx`
- Modify: `apps/mobile/app/__tests__/group-detail.test.tsx`
- Test: `apps/mobile/src/components/social/__tests__/CreateChallengeSheet.test.tsx`

**Interfaces:**
- Consumes: `useGroupChallenges`, `useCreateChallenge`, `Sheet`, `Button`, `AppText`, `Overline`, `useTheme`, `router`.
- Produces: `CreateChallengeSheet({ visible, groupId, onClose })`; a Challenges section rendered in `GroupDetail`.

- [ ] **Step 1: Write the failing `CreateChallengeSheet` test**

`apps/mobile/src/components/social/__tests__/CreateChallengeSheet.test.tsx`:
```typescript
import { fireEvent, render } from "@testing-library/react-native";

const mockMutate = jest.fn();
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useCreateChallenge: () => ({ mutate: mockMutate, isPending: false }),
}));

import { CreateChallengeSheet } from "../CreateChallengeSheet";

beforeEach(() => {
  mockMutate.mockReset();
  mockPush.mockReset();
});

test("blank title shows an error and does not mutate", async () => {
  const { getByText } = await render(<CreateChallengeSheet visible groupId="g1" onClose={jest.fn()} />);
  fireEvent.press(getByText("Create challenge"));
  expect(getByText("Name your challenge.")).toBeTruthy();
  expect(mockMutate).not.toHaveBeenCalled();
});

test("submits title, selected metric and duration then navigates on success", async () => {
  mockMutate.mockImplementation((_vars, opts) => opts.onSuccess({ id: "c9" }));
  const onClose = jest.fn();
  const { getByText, getByPlaceholderText } = await render(<CreateChallengeSheet visible groupId="g1" onClose={onClose} />);
  fireEvent.changeText(getByPlaceholderText("Challenge title"), "July streak");
  fireEvent.press(getByText("Logged days")); // pick the "logged" metric
  fireEvent.press(getByText("2 weeks")); // pick 2w
  fireEvent.press(getByText("Create challenge"));
  expect(mockMutate).toHaveBeenCalledWith(
    { groupId: "g1", title: "July streak", metric: "logged", duration: "2w" },
    expect.any(Object),
  );
  expect(onClose).toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith("/challenge/c9");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci CreateChallengeSheet`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `CreateChallengeSheet.tsx`**

`apps/mobile/src/components/social/CreateChallengeSheet.tsx`:
```typescript
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCreateChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { ChallengeSummary, Metric } from "@/api/types";

interface Props {
  visible: boolean;
  groupId: string;
  onClose: () => void;
}

const METRICS: { key: Metric; label: string }[] = [
  { key: "on_target", label: "On-target days" },
  { key: "logged", label: "Logged days" },
];
const DURATIONS: { key: string; label: string }[] = [
  { key: "1w", label: "1 week" },
  { key: "2w", label: "2 weeks" },
  { key: "1mo", label: "1 month" },
];

export function CreateChallengeSheet({ visible, groupId, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState<Metric>("on_target");
  const [duration, setDuration] = useState("1w");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateChallenge();

  const pill = (selected: boolean) => ({
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: selected ? colors.primary : colors.border,
    backgroundColor: selected ? colors.primary : "transparent",
  });

  const onSubmit = () => {
    const v = title.trim();
    if (!v) {
      setErr("Name your challenge.");
      return;
    }
    setErr(null);
    create.mutate(
      { groupId, title: v, metric, duration },
      {
        onSuccess: (c: ChallengeSummary) => {
          setTitle("");
          onClose();
          router.push(`/challenge/${c.id}` as Href);
        },
        onError: () => setErr("Couldn't create. Try again."),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: 14 }}>
        <Overline>New challenge</Overline>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoCapitalize="sentences"
          placeholder="Challenge title"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Challenge title"
          style={{ fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />

        <View style={{ gap: 8 }}>
          <Overline>Metric</Overline>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {METRICS.map((m) => (
              <Pressable key={m.key} accessibilityRole="button" onPress={() => setMetric(m.key)} style={pill(metric === m.key)}>
                <AppText style={{ color: metric === m.key ? colors.primaryForeground : colors.foreground, fontSize: 13 }}>{m.label}</AppText>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Overline>Duration</Overline>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {DURATIONS.map((dn) => (
              <Pressable key={dn.key} accessibilityRole="button" onPress={() => setDuration(dn.key)} style={pill(duration === dn.key)}>
                <AppText style={{ color: duration === dn.key ? colors.primaryForeground : colors.foreground, fontSize: 13 }}>{dn.label}</AppText>
              </Pressable>
            ))}
          </View>
        </View>

        {err ? <AppText style={{ color: colors.destructive }}>{err}</AppText> : null}
        <Button title="Create challenge" onPress={onSubmit} disabled={create.isPending} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run the sheet test to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci CreateChallengeSheet`
Expected: tsc clean; 2 tests PASS.

- [ ] **Step 5: Add the Challenges section to `group/[id].tsx`**

In `apps/mobile/app/group/[id].tsx`:
1. Add imports at the top:
```typescript
import { useState } from "react";
import { CreateChallengeSheet } from "@/components/social/CreateChallengeSheet";
import { useGroupChallenges } from "@/api/hooks";
import type { Href } from "expo-router";
```
(merge `useState` into existing react import if needed; `router`/`useLocalSearchParams` already imported from expo-router — add `type Href` there instead of a separate line if you prefer.)

2. Inside the component, after `const del = useDeleteGroup();`, add:
```typescript
  const challenges = useGroupChallenges(id);
  const [sheet, setSheet] = useState(false);
```

3. Wrap the returned `<ScrollView>` in a fragment and add the sheet, and insert the Challenges section inside the inner `<View style={{ paddingHorizontal: 20, gap: 20 }}>` — place it right BEFORE the owner/leave button block (`{isOwner ? (...) : (...)}`):
```typescript
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Overline>Challenges</Overline>
            <Pressable accessibilityRole="button" accessibilityLabel="New challenge" onPress={() => setSheet(true)}>
              <AppText style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>New challenge</AppText>
            </Pressable>
          </View>
          {(challenges.data ?? []).length === 0 ? (
            <AppText muted style={{ fontSize: 12 }}>No challenges yet. Start one.</AppText>
          ) : (
            (challenges.data ?? []).map((ch) => (
              <Pressable
                key={ch.id}
                accessibilityRole="button"
                onPress={() => router.push(`/challenge/${ch.id}` as Href)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{ch.title}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{`${ch.status} · ${ch.metric === "logged" ? "Logged days" : "On-target days"} · ${ch.participant_count} in`}</AppText>
                </View>
                {ch.joined ? <AppText muted style={{ fontSize: 11 }}>Joined</AppText> : null}
              </Pressable>
            ))
          )}
        </View>
```

4. After the closing `</ScrollView>`, before the final fragment close, add the conditional sheet:
```typescript
      {sheet ? <CreateChallengeSheet visible groupId={id} onClose={() => setSheet(false)} /> : null}
```
Return shape becomes `return (<> <ScrollView>…</ScrollView> {sheet ? … : null} </>);`.

- [ ] **Step 6: Update the group-detail test mock + add an assertion**

In `apps/mobile/app/__tests__/group-detail.test.tsx`, add to the `@/api/hooks` mock object:
```typescript
  useGroupChallenges: () => ({ data: [{ id: "c1", title: "July streak", metric: "logged", status: "active", start_date: "", end_date: "", participant_count: 2, joined: true }] }),
```
And add an assertion to the existing test:
```typescript
  expect(getByText("July streak")).toBeTruthy(); // challenges section
```

- [ ] **Step 7: Run mobile checks**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; whole suite PASS (group-detail test now also asserts the challenges row).

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/components/social/CreateChallengeSheet.tsx apps/mobile/app/group/[id].tsx apps/mobile/app/__tests__/group-detail.test.tsx apps/mobile/src/components/social/__tests__/CreateChallengeSheet.test.tsx
git commit -m "feat(mobile): challenges section in group detail + create sheet"
```

---

### Task 7: `app/challenge/[id].tsx` — challenge detail screen

**Files:**
- Create: `apps/mobile/app/challenge/[id].tsx`
- Test: `apps/mobile/app/__tests__/challenge-detail.test.tsx`

**Interfaces:**
- Consumes: `useChallenge`, `useJoinChallenge`, `useLeaveChallenge`, `useDeleteChallenge`, `ScreenHeader`, `AppText`, `Button`, `Overline`, `useTheme`, `router`, `useLocalSearchParams`, `useSafeAreaInsets`.
- Produces: the default-exported `ChallengeDetail` screen (auto-registered by expo-router file routing — no `_layout` change needed, mirroring `app/group/[id].tsx`).

- [ ] **Step 1: Write the failing screen test**

`apps/mobile/app/__tests__/challenge-detail.test.tsx`:
```typescript
import { render } from "@testing-library/react-native";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({ router: { back: mockBack }, useLocalSearchParams: () => ({ id: "c1" }) }));

const mockChallenge = {
  data: {
    id: "c1",
    title: "July streak",
    metric: "logged",
    status: "ended",
    start_date: "2026-07-01",
    end_date: "2026-07-08",
    joined: true,
    can_delete: true,
    standings: [
      { user_id: "u1", display_name: "Alice", score: 6 },
      { user_id: "u2", display_name: "Bob", score: 4 },
    ],
    winner: { user_id: "u1", display_name: "Alice", score: 6 },
  },
};
jest.mock("@/api/hooks", () => ({
  useChallenge: () => mockChallenge,
  useJoinChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useLeaveChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteChallenge: () => ({ mutate: jest.fn(), isPending: false }),
}));

import ChallengeDetailScreen from "../challenge/[id]";

test("renders standings, winner banner when ended, and Delete when can_delete", async () => {
  const { getByText } = await render(<ChallengeDetailScreen />);
  expect(getByText("July streak")).toBeTruthy();
  expect(getByText("1. Alice")).toBeTruthy();
  expect(getByText("2. Bob")).toBeTruthy();
  expect(getByText("🏆 Alice wins")).toBeTruthy();
  expect(getByText("Leave challenge")).toBeTruthy(); // joined -> Leave
  expect(getByText("Delete challenge")).toBeTruthy(); // can_delete
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci challenge-detail`
Expected: FAIL — screen module not found.

- [ ] **Step 3: Write `app/challenge/[id].tsx`**

`apps/mobile/app/challenge/[id].tsx`:
```typescript
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { useChallenge, useJoinChallenge, useLeaveChallenge, useDeleteChallenge } from "@/api/hooks";
import { useTheme } from "@/theme";

const METRIC_LABEL: Record<string, string> = { logged: "Logged days", on_target: "On-target days" };
const STATUS_LABEL: Record<string, string> = { upcoming: "Upcoming", active: "Active", ended: "Ended" };

export default function ChallengeDetailScreen() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const challenge = useChallenge(id);
  const join = useJoinChallenge();
  const leave = useLeaveChallenge();
  const del = useDeleteChallenge();

  const d = challenge.data;
  const groupError = null; // detail carries no group id; join/leave use the challenge id only.

  const onDelete = () =>
    Alert.alert("Delete this challenge?", "This removes it for everyone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => del.mutate({ challengeId: id, groupId: "" }, { onSuccess: () => router.back() }) },
    ]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline={d ? `${STATUS_LABEL[d.status]} · ${METRIC_LABEL[d.metric]}` : "Challenge"} title={d?.title ?? "Challenge"} onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 20, gap: 20 }}>
        {d?.status === "ended" && d.winner ? (
          <View style={{ padding: 16, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary }}>
            <AppText style={{ fontSize: 16, fontWeight: "700" }}>{`🏆 ${d.winner.display_name} wins`}</AppText>
            <AppText muted style={{ fontSize: 12 }}>{`${d.winner.score} ${d.metric === "logged" ? "days logged" : "days on target"}`}</AppText>
          </View>
        ) : null}

        <View style={{ gap: 10 }}>
          <Overline>Standings</Overline>
          {(d?.standings ?? []).length === 0 ? (
            <AppText muted style={{ fontSize: 12 }}>No one has joined yet.</AppText>
          ) : (
            (d?.standings ?? []).map((s, i) => (
              <View key={s.user_id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{`${i + 1}. ${s.display_name}`}</AppText>
                <AppText style={{ fontSize: 16, fontWeight: "700" }}>{s.score}</AppText>
              </View>
            ))
          )}
        </View>

        {groupError}

        {d ? (
          d.joined ? (
            <Button title="Leave challenge" variant="secondary" onPress={() => leave.mutate({ challengeId: id, groupId: "" })} disabled={leave.isPending} />
          ) : (
            <Button title="Join challenge" onPress={() => join.mutate({ challengeId: id, groupId: "" })} disabled={join.isPending} />
          )
        ) : null}

        {d?.can_delete ? <Button title="Delete challenge" variant="ghost" onPress={onDelete} disabled={del.isPending} /> : null}
      </View>
    </ScrollView>
  );
}
```

Note: the join/leave/delete hooks accept a `groupId` for list invalidation; the challenge-detail screen doesn't know the parent group id, so it passes `groupId: ""` — the `["challenge", id]` invalidation still refreshes this screen, and the parent group-challenges list refreshes when the user navigates back and it refetches on focus. (Remove the `groupError`/`const groupError` placeholder lines — they exist only to mark that this screen intentionally has no group context; delete both before finishing.)

- [ ] **Step 4: Run the screen test to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci challenge-detail`
Expected: tsc clean; test PASS.

- [ ] **Step 5: Run the full mobile suite**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; whole suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/challenge/[id].tsx apps/mobile/app/__tests__/challenge-detail.test.tsx
git commit -m "feat(mobile): challenge detail screen (standings, join/leave, winner, delete)"
```

---

## After the tasks

Run the **final whole-branch review on opus** over the range `main..HEAD` per the subagent-driven-development flow, with focus on: (1) the membership gate on every challenge read/write; (2) opt-in-is-consent — standings never route through `compare.ProgressForMembers` and only participants are scored; (3) the no-fabricated-nutrition invariant through `WindowScore`; (4) status/winner computed-not-stored. Fold any Critical/Important findings before proposing the FF-merge to `main` (user-directed).

## Self-Review notes (author)

- **Spec coverage:** migration+model+repo (T1); WindowScore both metrics (T2); service create/list/join/leave/detail/delete + gates + standings + status/winner (T3); handlers + six routes + wiring (T4); mobile types+hooks (T5); group-detail section + CreateChallengeSheet (T6); challenge detail screen (T7). Privacy/edges covered by gate tests in T3/T4; invariant covered by WindowScore tests (T2) + row-only ScoringRow. All spec sections map to a task.
- **Type consistency:** `Metric`, `Status(...)`, `durationDays`, `ScoringRow`, `Standing`, `ChallengeDetail`, `challengeStore`, `groupAccess` names are used identically across T1→T4; mobile `ChallengeSummary`/`ChallengeDetail`/`Metric`/`ChallengeStatus` identical across T5→T7. Hook mutation-arg shapes (`{groupId,...}` / `{challengeId,groupId}`) are consistent between hooks (T5) and callers (T6/T7).
- **Known small tradeoffs (flag at final review, not blockers):** `useCreateChallenge` is typed `Promise<ChallengeSummary>` but the backend `Create` returns the full `Challenge` (only `.id` consumed — matches the existing `useCreateGroup` convention); challenge-detail join/leave/delete pass `groupId: ""` (parent list refreshes on focus/navigation) since the detail payload carries no group id.
