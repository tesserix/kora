# Explicit Fasting Intervals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people declare a fast on the diary screen, so Kora stops inferring fasting from an absence of food logs.

**Architecture:** One table of intervals. A fast's end is resolved at READ time — the earliest of an explicit end, the first food log after it started, a 48h cap, and now — so no write path is hooked and no scheduled job is needed. The declared duration becomes a risk signal kept separate from the existing inferred one.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate; Expo SDK 57 / React Native + TanStack Query; Go `testing` + testify; jest.

**Spec:** `docs/superpowers/specs/2026-08-24-explicit-fasting-design.md` — read it first. The plan argues from it.

## Global Constraints

- **The repo is PUBLIC.** No real health values in code, tests, fixtures, commits or PRs. Use obviously-synthetic numbers.
- **Never run prettier.** No prettier config exists; it has silently swallowed an edit before.
- **Do not poll CI.** No `gh run watch`, no looping `gh run list`.
- **Mutation-check every new test** and report it concretely: broke X, went red with `<message>`, restored, green. If a mutation stays GREEN, report it — that has caught real defects repeatedly on this project.
- Commit messages: single line, conventional prefix, no signatures, no `Co-Authored-By`. Reference `(#407)`.
- **A declared fast must never become the only input to fasting risk.** Someone restricting will not tap "start fasting". `FastingStreakDays` stays exactly as it is; the declared signal is separate and additive.
- Exact values, verbatim: cap **48h**, risk threshold **24h**, measure is the **longest single fast**, window is the existing **7 days**.
- Effective end is always `min(explicit ended_at, first food log after started_at, started_at + 48h, now)`.
- **`go build ./...` must stay clean at every commit.** The local dev DB drifts behind migrations — apply yours before running DB-backed tests, and if a test fails on missing schema in a package you did NOT touch, confirm it fails on untouched `main` first.
- Kora's test Postgres is on **5433**, not 5432 (5432 in this workspace is an unrelated tesserix-marketplace instance). Run DB suites with `-p 1` — they do not close their gorm pools and exhaust `max_connections` when run concurrently.

---

### Task 1: Schema and the interval model

**Files:**
- Create: `api/internal/database/migrations/000052_fasting_intervals.up.sql`
- Create: `api/internal/database/migrations/000052_fasting_intervals.down.sql`
- Create: `api/internal/fasting/model.go`
- Test: `api/internal/database/migrations_fasting_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `fasting.Interval` with fields `ID uuid.UUID`, `UserID uuid.UUID`, `StartedAt time.Time`, `EndedAt *time.Time`, `EndedBy *string`, `LocalDate time.Time`, `CreatedAt time.Time`; and `const CapHours = 48`.

- [ ] **Step 1: Write the failing schema test**

Follow the shape of `api/internal/database/migrations_energy_resting_hr_test.go` — read it first and mirror how it opens the DB and queries `information_schema`.

```go
func TestFastingIntervalsSchema(t *testing.T) {
	db := testDB(t)

	// Columns exist with the right nullability.
	for _, c := range []struct {
		name     string
		nullable string
	}{
		{"user_id", "NO"}, {"started_at", "NO"}, {"ended_at", "YES"},
		{"ended_by", "YES"}, {"local_date", "NO"},
	} {
		var nullable string
		require.NoError(t, db.Raw(
			`SELECT is_nullable FROM information_schema.columns
			 WHERE table_name='fasting_intervals' AND column_name=?`, c.name).
			Scan(&nullable).Error)
		require.Equal(t, c.nullable, nullable, "%s nullability", c.name)
	}

	// The index that enforces one open fast per user must be PARTIAL.
	// Postgres treats NULLs as distinct, so a non-partial unique index on
	// (user_id) would reject a SECOND CLOSED fast too — a bug that passes
	// any test which only ever inserts one row.
	var indexdef string
	require.NoError(t, db.Raw(
		`SELECT indexdef FROM pg_indexes
		 WHERE tablename='fasting_intervals' AND indexname='fasting_intervals_one_open'`).
		Scan(&indexdef).Error)
	require.Contains(t, indexdef, "WHERE (ended_at IS NULL)",
		"the unique index must be partial, or a user could never fast twice")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./internal/database/ -run TestFastingIntervalsSchema -count=1 -p 1`
Expected: FAIL — the table does not exist, so the column scan returns no rows.

- [ ] **Step 3: Write the migration and the model**

`000052_fasting_intervals.up.sql`:

```sql
-- Declared fasting intervals (kora#407). Kora previously inferred fasting from
-- an ABSENCE of food logs, which cannot tell "not eating" from "not logging" —
-- see kora#408 for the production bug that caused. A declared fast is a fact.
--
-- ended_at/ended_by are set ONLY by an explicit end. The other two ways a fast
-- ends -- the next food log, and the 48h cap -- are resolved at READ time and
-- never stored, so there is no write path to forget to hook and no job to run.
CREATE TABLE fasting_intervals (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at   TIMESTAMPTZ,
    ended_by   TEXT,
    local_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fasting_intervals_ends_after_start
        CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT fasting_intervals_ended_by_check
        CHECK (ended_by IS NULL OR ended_by = 'user'),
    CONSTRAINT fasting_intervals_local_date_plausible
        CHECK (local_date > '2000-01-01'::date)
);

-- At most one OPEN fast per user. PARTIAL on purpose: a plain unique index on
-- (user_id) would also reject a second CLOSED fast, so nobody could ever fast
-- twice. ON CONFLICT against this index needs clause.TargetWhere with the
-- predicate matching verbatim, or Postgres errors 42P10.
CREATE UNIQUE INDEX fasting_intervals_one_open
    ON fasting_intervals (user_id) WHERE ended_at IS NULL;

CREATE INDEX idx_fasting_intervals_user_started
    ON fasting_intervals (user_id, started_at);
```

`000052_fasting_intervals.down.sql`:

```sql
DROP TABLE IF EXISTS fasting_intervals;
```

`api/internal/fasting/model.go`:

```go
// Package fasting stores DECLARED fasting intervals (kora#407).
//
// Kora's other fasting signal is inferred from an absence of food logs, which
// cannot distinguish "not eating" from "not logging" — see kora#408. This
// package exists so that a fast the user actually told us about is a fact
// rather than a guess. The two signals stay separate all the way through:
// a declared fast never feeds FastingStreakDays.
package fasting

import (
	"time"

	"github.com/google/uuid"
)

// CapHours bounds what any single fast can contribute, however long its row
// stays open. A user who taps start and never taps end -- or stops opening
// the app -- must not accrue an ever-growing fast that eventually trips the
// eating-disorder risk threshold on stale state. 48h leaves a genuine 24h+
// fast registering fully while an abandoned one plateaus.
const CapHours = 48

// EndedByUser is the only stored end reason. The food-log and cap endings are
// computed at read time and never written.
const EndedByUser = "user"

type Interval struct {
	ID        uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid()" json:"id"`
	UserID    uuid.UUID  `gorm:"type:uuid;not null" json:"user_id"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	EndedBy   *string    `json:"ended_by,omitempty"`
	LocalDate time.Time  `gorm:"type:date" json:"local_date"`
	CreatedAt time.Time  `json:"created_at"`
}

func (Interval) TableName() string { return "fasting_intervals" }
```

- [ ] **Step 4: Apply the migration and run the test**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go run ./cmd/migrate` then re-run the test from Step 2.
Expected: PASS.

- [ ] **Step 5: Mutation-check**

1. Drop `WHERE ended_at IS NULL` from the index (making it non-partial) — expect the `indexdef` assertion to fail. **Report this one explicitly: it is the trap the test exists for.**
2. Make `ended_at` `NOT NULL` — expect the nullability loop to fail on `ended_at`.
3. Apply the down migration and re-run — expect the column scan to find nothing. Re-apply up afterwards and confirm green.

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000052_fasting_intervals.up.sql \
        api/internal/database/migrations/000052_fasting_intervals.down.sql \
        api/internal/fasting/model.go \
        api/internal/database/migrations_fasting_test.go
git commit -m "feat(fasting): store declared fasting intervals (#407)"
```

---

### Task 2: Effective end and duration — the pure core

**Files:**
- Create: `api/internal/fasting/duration.go`
- Test: `api/internal/fasting/duration_test.go`

**Interfaces:**
- Consumes: `Interval`, `CapHours` from Task 1.
- Produces: `func EffectiveEnd(i Interval, firstLogAfterStart *time.Time, now time.Time) time.Time` and `func Hours(i Interval, firstLogAfterStart *time.Time, now time.Time) float64`.

- [ ] **Step 1: Write the failing test**

```go
package fasting

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func at(h int) time.Time {
	return time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC).Add(time.Duration(h) * time.Hour)
}
func ptr(t time.Time) *time.Time { return &t }

func TestHoursUsesTheExplicitEndWhenItIsEarliest(t *testing.T) {
	i := Interval{StartedAt: at(0), EndedAt: ptr(at(16))}
	require.InDelta(t, 16, Hours(i, nil, at(40)), 0.001)
}

func TestHoursUsesTheFirstFoodLogWhenItIsEarliest(t *testing.T) {
	// Eating IS the end of a fast. No explicit end was tapped.
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, 14, Hours(i, ptr(at(14)), at(40)), 0.001)
}

func TestHoursIgnoresAFoodLogBeforeTheFastStarted(t *testing.T) {
	i := Interval{StartedAt: at(10)}
	require.InDelta(t, 5, Hours(i, ptr(at(3)), at(15)), 0.001,
		"a log from before the fast began cannot have ended it")
}

func TestHoursCapsAnAbandonedFast(t *testing.T) {
	// Open, never ended, no food logged, and the user stopped opening the app.
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, CapHours, Hours(i, nil, at(500)), 0.001,
		"an abandoned fast must plateau, not accrue forever")
}

func TestHoursOfAnOpenFastIsItsDurationSoFar(t *testing.T) {
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, 30, Hours(i, nil, at(30)), 0.001,
		"a running fast counts now; waiting for an end would never notice the long ones")
}

func TestHoursNeverNegative(t *testing.T) {
	i := Interval{StartedAt: at(10)}
	require.InDelta(t, 0, Hours(i, nil, at(5)), 0.001,
		"a clock skew must not produce a negative fast")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/fasting/ -count=1`
Expected: FAIL — `undefined: Hours`.

- [ ] **Step 3: Write minimal implementation**

```go
package fasting

import "time"

// EffectiveEnd is when a fast actually ended, whatever the row says.
//
// Three of the four bounds are computed rather than stored (kora#407):
//
//   - the explicit end, when the user tapped it
//   - the first food log after the fast started -- eating IS the end of a
//     fast, and resolving it here means no food-log write path has to be
//     hooked. foodlog.Repository.Create has three call sites plus
//     CreateIdempotent; hooking all of them and missing one would leave
//     fasts silently open.
//   - started_at + CapHours, so an abandoned fast plateaus instead of
//     accruing into a false risk flag on stale state
//   - now, because a fast cannot extend into the future
//
// The earliest wins.
func EffectiveEnd(i Interval, firstLogAfterStart *time.Time, now time.Time) time.Time {
	end := i.StartedAt.Add(CapHours * time.Hour)
	if end.After(now) {
		end = now
	}
	if i.EndedAt != nil && i.EndedAt.Before(end) {
		end = *i.EndedAt
	}
	// A log at or before the start cannot have ended this fast.
	if firstLogAfterStart != nil && firstLogAfterStart.After(i.StartedAt) && firstLogAfterStart.Before(end) {
		end = *firstLogAfterStart
	}
	return end
}

// Hours is EffectiveEnd minus the start, floored at zero.
func Hours(i Interval, firstLogAfterStart *time.Time, now time.Time) float64 {
	d := EffectiveEnd(i, firstLogAfterStart, now).Sub(i.StartedAt).Hours()
	if d < 0 {
		return 0
	}
	return d
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && go test ./internal/fasting/ -count=1 -v`
Expected: PASS, all six.

- [ ] **Step 5: Mutation-check**

1. Remove the cap bound — expect `TestHoursCapsAnAbandonedFast` to fail.
2. Remove the `firstLogAfterStart.After(i.StartedAt)` guard — expect `TestHoursIgnoresAFoodLogBeforeTheFastStarted` to fail.
3. Remove the `now` bound — expect `TestHoursOfAnOpenFastIsItsDurationSoFar` to fail (it would return the cap).
4. Remove the negative floor — expect `TestHoursNeverNegative` to fail.

- [ ] **Step 6: Commit**

```bash
git add api/internal/fasting/duration.go api/internal/fasting/duration_test.go
git commit -m "feat(fasting): resolve a fast's effective end and duration (#407)"
```

---

### Task 3: Repository and the start/end endpoints

**Files:**
- Create: `api/internal/fasting/repository.go`
- Create: `api/internal/fasting/handler.go`
- Modify: `api/internal/server/router.go` (register beside the other v1 routes)
- Test: `api/internal/fasting/repository_test.go`, `api/internal/fasting/handler_test.go`

**Interfaces:**
- Consumes: `Interval`, `Hours` from Tasks 1-2.
- Produces: `Repository` with `Start(ctx, userID uuid.UUID, now time.Time, localDate time.Time) (Interval, error)`, `End(ctx, userID uuid.UUID, now time.Time) (Interval, bool, error)`, `Open(ctx, userID uuid.UUID) (Interval, bool, error)`, `Since(ctx, userID uuid.UUID, from time.Time) ([]Interval, error)`; `Handler` with `Start`, `End`, `Current`.

- [ ] **Step 1: Write the failing repository test**

Read `api/internal/tracking/repository_test.go` for how `testDB(t)` and `seedUser(t, db)` are used in this codebase, and mirror it.

```go
func TestStartIsIdempotent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	first, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	// A double-tap, or a client retry, must not 400 and must not open a second.
	second, err := repo.Start(context.Background(), userID, now.Add(time.Minute), now)
	require.NoError(t, err)
	require.Equal(t, first.ID, second.ID, "starting twice returns the SAME open fast")
}

func TestASecondOpenFastIsRejectedButASecondClosedFastIsFine(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	now := time.Now()

	_, err := repo.Start(context.Background(), userID, now.Add(-4*time.Hour), now)
	require.NoError(t, err)
	_, ended, err := repo.End(context.Background(), userID, now.Add(-time.Hour))
	require.NoError(t, err)
	require.True(t, ended)

	// The index is PARTIAL: once the first is closed, a second may open.
	// A non-partial unique index on (user_id) would reject this.
	_, err = repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err, "a user must be able to fast more than once")
}

func TestEndReportsWhenThereWasNothingOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, ended, err := repo.End(context.Background(), userID, time.Now())
	require.NoError(t, err, "ending nothing is not an error, just a no-op")
	require.False(t, ended)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./internal/fasting/ -count=1 -p 1`
Expected: FAIL — `undefined: NewRepository`.

- [ ] **Step 3: Write the repository**

```go
package fasting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Start opens a fast, or returns the one already open.
//
// Idempotent on purpose: a double-tap and a client retry are the same request
// as far as the user is concerned, and a 400 for either would be a bug the user
// experiences as the button not working.
func (r Repository) Start(ctx context.Context, userID uuid.UUID, now, localDate time.Time) (Interval, error) {
	if existing, ok, err := r.Open(ctx, userID); err != nil {
		return Interval{}, err
	} else if ok {
		return existing, nil
	}
	in := Interval{UserID: userID, StartedAt: now, LocalDate: localDate}
	if err := r.db.WithContext(ctx).Create(&in).Error; err != nil {
		return Interval{}, fmt.Errorf("fasting: start: %w", err)
	}
	return in, nil
}

// End closes the open fast. ok is false when there was nothing open, which is
// not an error -- the user tapped end on a screen that had gone stale.
func (r Repository) End(ctx context.Context, userID uuid.UUID, now time.Time) (Interval, bool, error) {
	open, ok, err := r.Open(ctx, userID)
	if err != nil || !ok {
		return Interval{}, false, err
	}
	by := EndedByUser
	open.EndedAt, open.EndedBy = &now, &by
	if err := r.db.WithContext(ctx).Model(&Interval{}).
		Where("id = ?", open.ID).
		Updates(map[string]any{"ended_at": now, "ended_by": by}).Error; err != nil {
		return Interval{}, false, fmt.Errorf("fasting: end: %w", err)
	}
	return open, true, nil
}

func (r Repository) Open(ctx context.Context, userID uuid.UUID) (Interval, bool, error) {
	var in Interval
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND ended_at IS NULL", userID).
		Order("started_at DESC").First(&in).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Interval{}, false, nil
	}
	if err != nil {
		return Interval{}, false, fmt.Errorf("fasting: open: %w", err)
	}
	return in, true, nil
}

// Since returns intervals that could intersect a window starting at `from`:
// anything that ended after it, plus anything still open.
func (r Repository) Since(ctx context.Context, userID uuid.UUID, from time.Time) ([]Interval, error) {
	out := []Interval{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND (ended_at IS NULL OR ended_at >= ?)", userID, from).
		Order("started_at ASC").Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("fasting: since: %w", err)
	}
	return out, nil
}
```

- [ ] **Step 4: Write the handler and register the routes**

```go
package fasting

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct{ repo Repository }

func NewHandler(repo Repository) Handler { return Handler{repo: repo} }

func (h Handler) Start(c *gin.Context) {
	userID, ok := h.userID(c)
	if !ok {
		return
	}
	now := time.Now()
	in, err := h.repo.Start(c.Request.Context(), userID, now, now.In(user.LocFromContext(c)))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not start the fast")
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}

func (h Handler) End(c *gin.Context) {
	userID, ok := h.userID(c)
	if !ok {
		return
	}
	in, ended, err := h.repo.End(c.Request.Context(), userID, time.Now())
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not end the fast")
		return
	}
	if !ended {
		// Nothing open is not an error: the screen had gone stale.
		c.JSON(http.StatusOK, gin.H{"data": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}

func (h Handler) Current(c *gin.Context) {
	userID, ok := h.userID(c)
	if !ok {
		return
	}
	in, open, err := h.repo.Open(c.Request.Context(), userID)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not read the fast")
		return
	}
	if !open {
		c.JSON(http.StatusOK, gin.H{"data": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": in})
}

func (h Handler) userID(c *gin.Context) (uuid.UUID, bool) {
	raw, exists := c.Get("user_id")
	if !exists {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "no user")
		return uuid.Nil, false
	}
	id, ok := raw.(uuid.UUID)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "no user")
		return uuid.Nil, false
	}
	return id, true
}
```

Read how a neighbouring handler resolves the user (`tracking.Handler.resolveUser`) and match it rather than the sketch above if it differs — the `c.Get("user_id")` value's concrete type must match what the auth middleware sets.

In `api/internal/server/router.go`, beside the other `v1` registrations:

```go
fastingRepo := fasting.NewRepository(deps.DB)
fastingHandler := fasting.NewHandler(fastingRepo)
v1.POST("/fasting/start", fastingHandler.Start)
v1.POST("/fasting/end", fastingHandler.End)
v1.GET("/fasting/current", fastingHandler.Current)
```

- [ ] **Step 4b: Write the handler test**

The handler's own behaviour, distinct from the repository's: ending nothing is a
200 with a null body, not a 404 and not an error. A stale screen must not
produce a scary failure.

```go
func fastingRouter(userID uuid.UUID, repo Repository) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	h := NewHandler(repo)
	r.POST("/v1/fasting/start", h.Start)
	r.POST("/v1/fasting/end", h.End)
	r.GET("/v1/fasting/current", h.Current)
	return r
}

func TestEndingNothingIsA200WithNoBody(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := fastingRouter(userID, NewRepository(db))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/fasting/end", nil))
	require.Equal(t, http.StatusOK, w.Code, "a stale screen is not an error")

	var body struct {
		Data *Interval `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Nil(t, body.Data)
}

func TestCurrentReportsTheOpenFast(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	r := fastingRouter(userID, repo)

	now := time.Now()
	started, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/fasting/current", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data *Interval `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotNil(t, body.Data)
	require.Equal(t, started.ID, body.Data.ID)
}
```

- [ ] **Step 5: Run tests**

Run: `cd api && go build ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./internal/fasting/ -count=1 -p 1`
Expected: PASS.

- [ ] **Step 6: Mutation-check**

1. Make `Start` always insert (drop the `Open` short-circuit) — expect `TestStartIsIdempotent` to fail, and note whether it fails on the ID assertion or on a unique-violation error; either is a pass for the mutation.
2. Change the partial index to non-partial in the migration and re-apply — expect `TestASecondOpenFastIsRejectedButASecondClosedFastIsFine` to fail. **Report this explicitly.** Restore the partial index afterwards.
3. Make `End` return an error when nothing is open — expect `TestEndReportsWhenThereWasNothingOpen` AND `TestEndingNothingIsA200WithNoBody` to fail.
4. Make the handler return 404 when nothing is open — expect `TestEndingNothingIsA200WithNoBody` to fail on the status.

- [ ] **Step 7: Commit**

```bash
git add api/internal/fasting/repository.go api/internal/fasting/handler.go \
        api/internal/fasting/repository_test.go api/internal/fasting/handler_test.go \
        api/internal/server/router.go
git commit -m "feat(fasting): start, end and read the current fast (#407)"
```

---

### Task 4: The declared-fast risk signal

**Files:**
- Modify: `api/internal/guardrails/policy.go`
- Modify: `api/internal/coach/grounding.go`
- Modify: `api/internal/coach/signals.go`
- Modify: `api/internal/server/router.go` (pass the fasting source to the grounder)
- Test: `api/internal/guardrails/policy_test.go`, `api/internal/coach/grounding_test.go`

**Interfaces:**
- Consumes: `fasting.Interval`, `fasting.Hours`, `fasting.Repository.Since`.
- Produces: `guardrails.Signals.DeclaredFastHours float64`; `coach.FastingSource` with `Since(ctx, userID uuid.UUID, from time.Time) ([]fasting.Interval, error)`; `coach.Context.DeclaredFastHours float64`.

- [ ] **Step 1: Write the failing policy test**

```go
// kora#407. A DECLARED fast is a fact, unlike the inferred FastingStreakDays.
// It gets its own threshold so the two can be tuned apart, and so a suppression
// says which signal fired.
func TestAtRiskOnALongDeclaredFast(t *testing.T) {
	require.True(t, AtRisk(Signals{DeclaredFastHours: 30}))
	require.True(t, AtRisk(Signals{DeclaredFastHours: 24}), "the threshold is inclusive")
}

// The false positive this threshold exists to prevent. A routine 16:8 faster
// must not be flagged every single day.
func TestRoutineOvernightFastingIsNotRisk(t *testing.T) {
	require.False(t, AtRisk(Signals{DeclaredFastHours: 16}))
}

func TestNoDeclaredFastIsNotRisk(t *testing.T) {
	require.False(t, AtRisk(Signals{DeclaredFastHours: 0}))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && go test ./internal/guardrails/ -count=1`
Expected: FAIL — `unknown field DeclaredFastHours`.

- [ ] **Step 3: Add the field and the threshold**

In `policy.go`, beside the existing four thresholds:

```go
	// riskDeclaredFastHours is the length of a single DECLARED fast at or
	// above which risk fires (kora#407).
	//
	// 24h so that routine intermittent fasting -- 16:8 tops out at 16 --
	// never trips it, while a fast spanning a full day does. This is the
	// LONGEST single fast, never a sum: seven 16-hour overnight fasts total
	// 112 hours and mean nothing, and summing would flag exactly the
	// practice this threshold exists to spare.
	riskDeclaredFastHours = 24
```

On `Signals`:

```go
	// DeclaredFastHours is the longest SINGLE declared fast intersecting the
	// window, capped per fasting.CapHours. Separate from FastingStreakDays on
	// purpose: that one is inferred from an absence of logs and needed its own
	// fix (kora#408), and conflating "we guessed" with "they told us" would
	// make both harder to reason about.
	DeclaredFastHours float64
```

In `AtRisk`, beside the existing checks:

```go
	if s.DeclaredFastHours >= riskDeclaredFastHours {
		return true
	}
```

- [ ] **Step 4: Wire it through the grounder**

In `coach/grounding.go`, add the source interface beside `WeightSource`:

```go
// FastingSource is the DECLARED-fasting read. fasting.Repository satisfies it.
type FastingSource interface {
	Since(ctx context.Context, userID uuid.UUID, from time.Time) ([]fasting.Interval, error)
}
```

Add `Fasting FastingSource` to `Grounder`, a `WithFasting` builder mirroring `WithMentor`, and `DeclaredFastHours float64` to `Context`.

In `BuildContext`, after the recent-logs read:

```go
	// kora#407. NOT swallowed, unlike the WeightSource read above: a swallowed
	// error here yields 0 hours, which reads as "no long fast" -- failing OPEN
	// on a risk input. Propagating turns an unknown into a suppression rather
	// than a false all-clear.
	var declaredFastHours float64
	if g.Fasting != nil {
		intervals, err := g.Fasting.Since(ctx, userID, since)
		if err != nil {
			return Context{}, fmt.Errorf("coach: build context: declared fasts: %w", err)
		}
		for _, in := range intervals {
			// The first log strictly AFTER this fast began -- computed per
			// interval, not once. logs[0] is the earliest log in the WINDOW,
			// which for a fast that started later is simply the wrong log:
			// EffectiveEnd would discard it (it predates the start) and then
			// nothing would end the fast, over-counting its duration and
			// over-firing risk.
			var firstLog *time.Time
			for i := range logs {
				if logs[i].LoggedAt.After(in.StartedAt) {
					firstLog = &logs[i].LoggedAt
					break
				}
			}
			if h := fasting.Hours(in, firstLog, now); h > declaredFastHours {
				declaredFastHours = h
			}
		}
	}
```

`logs` is already sorted ascending by `ListForUserSince`; confirm that before relying on `logs[0]` being the earliest.

In `signals.go`, carry it into `Signals`:

```go
		DeclaredFastHours: c.DeclaredFastHours,
```

And in `router.go`, add `.WithFasting(fastingRepo)` to the `coachGrounder` construction.

- [ ] **Step 5: Write the grounding test**

```go
// The false positive that matters: several routine overnight fasts must not
// add up into a risk signal. This is the test a "sum them" refactor breaks.
func TestSevenShortDeclaredFastsAreNotRisk(t *testing.T) {
	var intervals []fasting.Interval
	base := time.Date(2026, 8, 17, 20, 0, 0, 0, time.UTC)
	for d := 0; d < 7; d++ {
		s := base.AddDate(0, 0, d)
		e := s.Add(16 * time.Hour)
		intervals = append(intervals, fasting.Interval{StartedAt: s, EndedAt: &e})
	}
	var longest float64
	for _, in := range intervals {
		if h := fasting.Hours(in, nil, base.AddDate(0, 0, 8)); h > longest {
			longest = h
		}
	}
	require.InDelta(t, 16, longest, 0.001, "the measure is the LONGEST fast, never the sum")
	require.False(t, guardrails.AtRisk(guardrails.Signals{DeclaredFastHours: longest}))
}
```

- [ ] **Step 6: Run everything**

Run: `cd api && go build ./... && go vet ./internal/fasting/ ./internal/coach/ ./internal/guardrails/ && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./internal/fasting/ ./internal/coach/ ./internal/guardrails/ -count=1 -p 1`
Expected: PASS.

- [ ] **Step 7: Mutation-check**

1. `riskDeclaredFastHours` 24 → 48 — expect `TestAtRiskOnALongDeclaredFast` to fail.
2. `riskDeclaredFastHours` 24 → 12 — expect `TestRoutineOvernightFastingIsNotRisk` to fail.
3. Change the grounder loop from max to sum — expect `TestSevenShortDeclaredFastsAreNotRisk` to fail. **Report this explicitly: it is the false positive the design exists to prevent.**
4. Swallow the `Fasting.Since` error (return `Context{}, nil` on error) — write a test with a failing `FastingSource` asserting the error reaches the caller, then confirm this mutation fails it.

- [ ] **Step 8: Commit**

```bash
git add api/internal/guardrails/ api/internal/coach/ api/internal/server/router.go
git commit -m "feat(guardrails): count a long declared fast as its own risk signal (#407)"
```

---

### Task 5: The diary control

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Modify: `apps/mobile/app/(tabs)/diary.tsx`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`, `apps/mobile/app/(tabs)/__tests__/diary.test.tsx`

**Interfaces:**
- Consumes: the three endpoints from Task 3.
- Produces: `FastingInterval` type; `useCurrentFast()`, `useStartFast()`, `useEndFast()`.

- [ ] **Step 1: Write the failing hook test**

```tsx
test("useStartFast POSTs and invalidates the current fast", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({
    id: "f1", user_id: "u1", started_at: "2026-08-24T06:00:00Z", local_date: "2026-08-24",
  });
  const { result } = await renderHook(() => useStartFast(), { wrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/fasting/start", { method: "POST" });
});

test("useCurrentFast tolerates no open fast", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce(null);
  const { result } = await renderHook(() => useCurrentFast(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest hooks.test -t useStartFast`
Expected: FAIL — `useStartFast is not a function`.

- [ ] **Step 3: Add the type and hooks**

In `types.ts`:

```ts
/** A declared fast. `ended_at` absent means still open. */
export interface FastingInterval {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string;
  ended_by?: string;
  local_date: string;
}
```

In `hooks.ts`, following how `useAddWater` and its neighbours are written:

```ts
export function useCurrentFast() {
  return useQuery({
    queryKey: ["fasting-current"],
    queryFn: () => apiFetch("/v1/fasting/current") as Promise<FastingInterval | null>,
  });
}

export function useStartFast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/fasting/start", { method: "POST" }) as Promise<FastingInterval>,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fasting-current"] }),
  });
}

export function useEndFast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/fasting/end", { method: "POST" }) as Promise<FastingInterval | null>,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fasting-current"] }),
  });
}
```

Match the exact `apiFetch` call shape used by `useAddWater` — read it rather than assuming the options object above is right.

- [ ] **Step 4: Add the control to the diary screen**

Beside the water control, using that screen's existing style variables:

```tsx
{currentFast.data ? (
  <PressableScale
    accessibilityRole="button"
    accessibilityLabel="End fast"
    onPress={() => endFast.mutate()}
  >
    <AppText>{`End fast · ${fastElapsedLabel(currentFast.data.started_at)}`}</AppText>
  </PressableScale>
) : (
  <PressableScale
    accessibilityRole="button"
    accessibilityLabel="Start fast"
    onPress={() => startFast.mutate()}
  >
    <AppText>Start fast</AppText>
  </PressableScale>
)}
```

Write `fastElapsedLabel(startedAt: string): string` as a pure function in `apps/mobile/src/lib/fastingCopy.ts` returning e.g. `"3h 20m"`, and give it its own tests: under an hour, exactly an hour, and past the 48h cap (which must read as the cap, not more — mirroring the server).

- [ ] **Step 5: Write the screen test**

```tsx
test("offers to start a fast when none is open", async () => {
  mockCurrentFast.mockReturnValue({ data: null, isSuccess: true });
  const { getByLabelText } = await render(<Diary />);
  expect(getByLabelText("Start fast")).toBeTruthy();
});

test("offers to end the fast that is open, with its elapsed time", async () => {
  mockCurrentFast.mockReturnValue({
    data: { id: "f1", started_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
    isSuccess: true,
  });
  const { getByLabelText } = await render(<Diary />);
  expect(getByLabelText("End fast")).toBeTruthy();
});
```

Mock `@/api/hooks` the way `diary.test.tsx` already does. **The factory replaces the whole module**, so every hook the screen imports must appear in it or it arrives `undefined` at render — this has cost time twice on this project.

- [ ] **Step 6: Run everything**

Run: `cd apps/mobile && npx jest && npx tsc --noEmit && npx eslint "app/(tabs)/diary.tsx" src/api/hooks.ts src/lib/fastingCopy.ts`
Expected: all green. Report actual output.

- [ ] **Step 7: Mutation-check**

1. Render the start button regardless of `currentFast.data` — expect the end-fast test to fail.
2. Make `fastElapsedLabel` ignore the cap — expect its cap test to fail.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts \
        "apps/mobile/app/(tabs)/diary.tsx" apps/mobile/src/lib/fastingCopy.ts \
        apps/mobile/src/api/__tests__/hooks.test.tsx \
        "apps/mobile/app/(tabs)/__tests__/diary.test.tsx" \
        apps/mobile/src/lib/__tests__/fastingCopy.test.ts
git commit -m "feat(diary): declare the start and end of a fast (#407)"
```

---

## Verification this plan cannot provide

**jest performs no layout in this repo.** Task 5's tests prove the control is in the render tree; they prove nothing about whether it is visible or reachable on a diary screen that is gaining a row. A Save button in this codebase once measured 743pt below the fold and shipped a silent failure (#374).

A simulator or device check is required before this is called done, and could not be performed from this environment: synthetic input needs accessibility privileges not granted on this machine.

**Also unverified:** that the risk threshold is set correctly for real users. 24h and 48h are judgment calls with no evidence behind the specific numbers, as the spec says. The first real 16:8 faster is the test that matters, and there is no way to run it here.
