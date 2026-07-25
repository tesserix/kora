# Compare Progress (Social B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let friends compare habit metrics — log streak + goal-adherence — behind a global opt-in `share_progress` consent gate, shown as a ranked leaderboard on the Friends screen.

**Architecture:** A `share_progress` bool on users (migration `000010`) + `PATCH /v1/me/share-progress`. A reusable, stub-testable `internal/progress` package computes `{streak, adherence}` from `food_logs` + `target_kcal`. A new `internal/compare` service composes the caller's metrics with each **sharing** friend's metrics behind a server-side consent gate, exposed at `GET /v1/friends/progress`. Mobile adds two hooks, a share toggle, and a `FriendsLeaderboard` on the existing Friends screen.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate (Postgres); React Native / Expo (SDK 57), expo-router, TanStack Query v5, Jest + RNTL v14, TypeScript.

## Global Constraints

- Backend DB tests run against `kora_test`: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`. Run tests FOREGROUND.
- After adding migration files, apply to `kora_test` before DB tests: from `api/`, `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`.
- Stale RED LSP diagnostics after a test-before-impl step are normal on Go — verify with `go build ./...` / `go test`, not the editor.
- Handlers resolve the caller via `user.IDFromContext(c)` (context key `user_id`); test routers set `c.Set("user_id", uuid)`. Day/tz for metrics: `time.Now()` + `user.LocFromContext(c)`.
- Response envelope: `httpx.OK(c, data)` → `{"data":…}`; `httpx.Error(c, status, code, msg)` → `{"error":code,"message":msg}`. No internal detail leaked.
- **Consent gate is server-side**: a non-sharing friend's metrics must never be computed into the response.
- Mobile: `npx tsc --noEmit` + `npm test -- --ci` stay green (currently 162/162). Jest `jest.mock` factories reference only `mock`-prefixed vars.
- Conventional single-line commits, no signature. No pushing until the user approves.
- Adherence: over the last 7 local days, count days whose total `kcal` is within ±10% of `target_kcal`; `target_kcal==0` → 0.

---

### Task 1: Migration `000010` + `share_progress` toggle

**Files:**
- Create: `api/internal/database/migrations/000010_share_progress.up.sql`, `…down.sql`
- Modify: `api/internal/user/model.go` (add `ShareProgress`)
- Modify: `api/internal/user/repository.go` (add `SetShareProgress`)
- Modify: `api/internal/user/handler.go` (add `UpdateShareProgress`)
- Modify: `api/internal/server/router.go` (wire `PATCH /v1/me/share-progress`)
- Test: `api/internal/user/share_progress_test.go`

**Interfaces:**
- Produces: `user.User.ShareProgress bool`; `user.Repository.SetShareProgress(ctx,id,bool)error`; `PATCH /v1/me/share-progress` body `{share_progress bool}` → updated profile.

- [ ] **Step 1: Migration files.**

`000010_share_progress.up.sql`:
```sql
ALTER TABLE users ADD COLUMN share_progress BOOLEAN NOT NULL DEFAULT false;
```
`000010_share_progress.down.sql`:
```sql
ALTER TABLE users DROP COLUMN IF EXISTS share_progress;
```

- [ ] **Step 2: Apply to kora_test.**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`
Expected: exits 0; `schema_migrations` version 10, not dirty.

- [ ] **Step 3: Model + repo + handler.**

`user/model.go` — add after `DisplayName` (or near the profile fields):
```go
	ShareProgress bool `json:"share_progress"`
```

`user/repository.go` — add:
```go
func (r Repository) SetShareProgress(ctx context.Context, id uuid.UUID, share bool) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("share_progress", share).Error; err != nil {
		return fmt.Errorf("user: set share progress: %w", err)
	}
	return nil
}
```

`user/handler.go` — add (`IDFromContext` is in this package; `net/http` + `httpx` already imported):
```go
type shareProgressBody struct {
	ShareProgress bool `json:"share_progress"`
}

func (h Handler) UpdateShareProgress(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req shareProgressBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	if err := h.repo.SetShareProgress(c.Request.Context(), id, req.ShareProgress); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not update sharing")
		return
	}
	u, err := h.repo.ByID(c.Request.Context(), id)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load profile")
		return
	}
	httpx.OK(c, u)
}
```
(`h.repo.ByID` was added in the Friends feature. Add `"github.com/google/uuid"` to `user/handler.go` imports only if not already present — `IDFromContext` returns `uuid.UUID` but is used without naming the type here, so no new import is needed.)

`server/router.go` — after the existing `v1.GET("/me", userHandler.Me)` line add:
```go
			v1.PATCH("/me/share-progress", userHandler.UpdateShareProgress)
```

- [ ] **Step 4: Write the failing test.** `api/internal/user/share_progress_test.go`:

```go
package user

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func spTestDB(t *testing.T) *gorm.DB {
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

func TestUpdateShareProgressTogglesAndPersists(t *testing.T) {
	db := spTestDB(t)
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "sp-"+id.String(), "sp@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", id); c.Next() })
	h := NewHandler(NewRepository(db))
	r.PATCH("/v1/me/share-progress", h.UpdateShareProgress)

	req := httptest.NewRequest(http.MethodPatch, "/v1/me/share-progress", strings.NewReader(`{"share_progress":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			ShareProgress bool `json:"share_progress"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.True(t, body.Data.ShareProgress)

	// persisted
	u, err := NewRepository(db).ByID(context.Background(), id)
	require.NoError(t, err)
	require.True(t, u.ShareProgress)
}
```

- [ ] **Step 5: Run to verify fail, then implement (Step 3 already has it), then verify pass.**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/user/... && go build ./...`
Expected: PASS after Step 3; build clean.

- [ ] **Step 6: Commit**
```bash
git add api/internal/database/migrations/000010_share_progress.up.sql api/internal/database/migrations/000010_share_progress.down.sql api/internal/user/model.go api/internal/user/repository.go api/internal/user/handler.go api/internal/server/router.go api/internal/user/share_progress_test.go
git commit -m "feat(user): share_progress column + PATCH /me/share-progress"
```

---

### Task 2: `internal/progress` package + `foodlog.DailyKcal`

**Files:**
- Modify: `api/internal/foodlog/repository.go` (add `DailyKcal`)
- Create: `api/internal/progress/progress.go`
- Test: `api/internal/progress/progress_test.go` (stub-based, no DB)
- Test: `api/internal/foodlog/daily_kcal_test.go` (DB)

**Interfaces:**
- Produces: `foodlog.Repository.DailyKcal(ctx,userID,from,to,loc)(map[string]float64,error)`; `progress.LogSource` interface; `progress.Metrics{StreakDays,AdherenceDays,AdherenceWindow int}` (json `streak_days`/`adherence_days`/`adherence_window`); `progress.Compute(ctx, logs LogSource, userID, targetKcal, day, loc)(Metrics,error)`.

- [ ] **Step 1: Add `DailyKcal` to `foodlog/repository.go`** (mirrors `LoggedDaysDesc`'s Raw-SQL local-day bucketing):

```go
// DailyKcal returns total kcal grouped by local calendar day (YYYY-MM-DD in loc)
// over [from, to). Days with no logs are simply absent from the map.
func (r Repository) DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (map[string]float64, error) {
	tz := loc.String()
	type row struct {
		Day  string
		Kcal float64
	}
	var rows []row
	err := r.db.WithContext(ctx).
		Raw("SELECT to_char(logged_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day, COALESCE(SUM(kcal), 0) AS kcal FROM food_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ? GROUP BY day",
			tz, userID, from, to).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: daily kcal: %w", err)
	}
	out := make(map[string]float64, len(rows))
	for _, rw := range rows {
		out[rw.Day] = rw.Kcal
	}
	return out, nil
}
```

- [ ] **Step 2: Write the failing progress tests.** `api/internal/progress/progress_test.go`:

```go
package progress

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type stubLogs struct {
	days []string
	kcal map[string]float64
}

func (s stubLogs) LoggedDaysDesc(_ context.Context, _ uuid.UUID, _ time.Time, _ *time.Location, _ int) ([]string, error) {
	return s.days, nil
}
func (s stubLogs) DailyKcal(_ context.Context, _ uuid.UUID, _, _ time.Time, _ *time.Location) (map[string]float64, error) {
	return s.kcal, nil
}

func TestComputeStreakAndAdherenceBand(t *testing.T) {
	loc := time.UTC
	day := time.Date(2026, 4, 10, 15, 0, 0, 0, loc) // endDay = 2026-04-10
	stub := stubLogs{
		days: []string{"2026-04-10", "2026-04-09", "2026-04-07"}, // gap at 04-08 breaks streak at 2
		kcal: map[string]float64{
			"2026-04-10": 2000, // exactly on target -> in band
			"2026-04-09": 2200, // +10% exactly -> in band (<=)
			"2026-04-08": 2201, // just over +10% -> out
			"2026-04-07": 1000, // under -> out
		},
	}
	m, err := Compute(context.Background(), stub, uuid.New(), 2000, day, loc)
	require.NoError(t, err)
	require.Equal(t, 2, m.StreakDays)
	require.Equal(t, 2, m.AdherenceDays)
	require.Equal(t, 7, m.AdherenceWindow)
}

func TestComputeZeroTargetHasNoAdherence(t *testing.T) {
	loc := time.UTC
	day := time.Date(2026, 4, 10, 15, 0, 0, 0, loc)
	stub := stubLogs{days: []string{"2026-04-10"}, kcal: map[string]float64{"2026-04-10": 1500}}
	m, err := Compute(context.Background(), stub, uuid.New(), 0, day, loc)
	require.NoError(t, err)
	require.Equal(t, 1, m.StreakDays)
	require.Equal(t, 0, m.AdherenceDays)
}
```

- [ ] **Step 3: Run to verify fail**

Run (from `api/`): `go test ./internal/progress/...`
Expected: BUILD ERROR — `Compute` undefined.

- [ ] **Step 4: Write `api/internal/progress/progress.go`:**

```go
// Package progress computes habit metrics (log streak, calorie-target adherence)
// from a user's food logs. It is deliberately independent of the dashboard so it
// can be reused (e.g. by friend comparison) without coupling.
package progress

import (
	"context"
	"math"
	"time"

	"github.com/google/uuid"
)

const (
	adherenceWindow = 7
	adherenceBand   = 0.10
)

// Metrics is a user's habit summary. AdherenceDays counts, over the last
// AdherenceWindow local days, days whose kcal was within ±10% of target.
type Metrics struct {
	StreakDays      int `json:"streak_days"`
	AdherenceDays   int `json:"adherence_days"`
	AdherenceWindow int `json:"adherence_window"`
}

// LogSource is the slice of foodlog.Repository this package needs.
type LogSource interface {
	LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error)
	DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (map[string]float64, error)
}

func Compute(ctx context.Context, logs LogSource, userID uuid.UUID, targetKcal float64, day time.Time, loc *time.Location) (Metrics, error) {
	local := day.In(loc)
	endDay := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)

	loggedDays, err := logs.LoggedDaysDesc(ctx, userID, day, loc, 4000)
	if err != nil {
		return Metrics{}, err
	}
	have := make(map[string]bool, len(loggedDays))
	for _, d := range loggedDays {
		have[d] = true
	}
	streak := 0
	for c := endDay; have[c.Format("2006-01-02")]; c = c.AddDate(0, 0, -1) {
		streak++
	}

	from := endDay.AddDate(0, 0, -(adherenceWindow - 1))
	to := endDay.AddDate(0, 0, 1)
	kcalByDay, err := logs.DailyKcal(ctx, userID, from, to, loc)
	if err != nil {
		return Metrics{}, err
	}
	adherence := 0
	if targetKcal > 0 {
		for i := 0; i < adherenceWindow; i++ {
			key := endDay.AddDate(0, 0, -i).Format("2006-01-02")
			if math.Abs(kcalByDay[key]-targetKcal) <= adherenceBand*targetKcal {
				adherence++
			}
		}
	}
	return Metrics{StreakDays: streak, AdherenceDays: adherence, AdherenceWindow: adherenceWindow}, nil
}
```

- [ ] **Step 5: Write the DB test for DailyKcal.** `api/internal/foodlog/daily_kcal_test.go`:

```go
package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestDailyKcalBucketsByLocalDay(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Kcal Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	d := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	// 100g of a 100kcal/100g item = 100 kcal each. Two on 04-10 (=>200), one on 04-09 (=>100).
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual", QuantityGrams: 100, LoggedAt: d})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(2 * time.Hour)})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(-24 * time.Hour)})

	from := time.Date(2026, 4, 8, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	m, err := NewRepository(db).DailyKcal(context.Background(), userID, from, to, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 200.0, m["2026-04-10"])
	require.Equal(t, 100.0, m["2026-04-09"])
}
```

- [ ] **Step 6: Run all to verify pass**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/progress/... ./internal/foodlog/... && go build ./...`
Expected: PASS; build clean.

- [ ] **Step 7: Commit**
```bash
git add api/internal/foodlog/repository.go api/internal/foodlog/daily_kcal_test.go api/internal/progress/progress.go api/internal/progress/progress_test.go
git commit -m "feat(progress): streak + adherence metrics + foodlog DailyKcal"
```

---

### Task 3: `compare` service + `GET /v1/friends/progress`

**Files:**
- Modify: `api/internal/social/repository.go` (add `ListAcceptedForCompare` + `CompareRow`)
- Create: `api/internal/compare/service.go`
- Create: `api/internal/compare/handler.go`
- Modify: `api/internal/server/router.go` (wire the route)
- Test: `api/internal/social/compare_rows_test.go` (DB)
- Test: `api/internal/compare/compare_test.go` (stub-based, no DB)

**Interfaces:**
- Consumes: `social.Repository` (Task adds `ListAcceptedForCompare`), `user.Repository.ByID`, `progress.Compute`/`progress.LogSource` (`foodlog.Repository`).
- Produces: `social.CompareRow{ID uuid.UUID; DisplayName string; ShareProgress bool; TargetKcal float64}`; `social.Repository.ListAcceptedForCompare(ctx,userID)([]CompareRow,error)`; `compare.NewService(friends, users, logs) Service`; `compare.Service.Compare(ctx,userID,day,loc)(Result,error)`; `compare.NewHandler(svc).Get`.

- [ ] **Step 1: Add `ListAcceptedForCompare` to `social/repository.go`:**

```go
// CompareRow is an accepted friend plus the fields needed to compute their
// shared progress (share_progress gates whether metrics are computed at all).
type CompareRow struct {
	ID            uuid.UUID
	DisplayName   string
	ShareProgress bool
	TargetKcal    float64
}

func (r Repository) ListAcceptedForCompare(ctx context.Context, userID uuid.UUID) ([]CompareRow, error) {
	rows := []CompareRow{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("u.id AS id, u.display_name AS display_name, u.share_progress AS share_progress, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END", userID).
		Where("f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)", FriendStatusAccepted, userID, userID).
		Order("u.display_name ASC").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("social: list accepted for compare: %w", err)
	}
	return rows, nil
}
```

- [ ] **Step 2: Write the failing DB test for the projection.** `api/internal/social/compare_rows_test.go`:

```go
package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestListAcceptedForCompareCarriesShareAndTarget(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	sharer := seedUser(t, db, "Sharer")
	private := seedUser(t, db, "Private")
	require.NoError(t, db.Exec("UPDATE users SET share_progress = true, target_kcal = 2100 WHERE id = ?", sharer).Error)
	require.NoError(t, db.Exec("UPDATE users SET share_progress = false, target_kcal = 1800 WHERE id = ?", private).Error)

	repo := NewRepository(db)
	_, err := repo.Create(context.Background(), Friendship{RequesterID: me, AddresseeID: sharer, Status: FriendStatusAccepted})
	require.NoError(t, err)
	_, err = repo.Create(context.Background(), Friendship{RequesterID: private, AddresseeID: me, Status: FriendStatusAccepted})
	require.NoError(t, err)

	rows, err := repo.ListAcceptedForCompare(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	byName := map[string]CompareRow{}
	for _, r := range rows {
		byName[r.DisplayName] = r
	}
	require.True(t, byName["Sharer"].ShareProgress)
	require.Equal(t, 2100.0, byName["Sharer"].TargetKcal)
	require.False(t, byName["Private"].ShareProgress)
}
```

- [ ] **Step 3: Run to verify fail**

Run (from `api/`): `TEST_DATABASE_URL=…/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/...`
Expected: BUILD ERROR — `ListAcceptedForCompare`/`CompareRow` undefined. (After Step 1 code it should pass; write Step 1 then re-run.)

- [ ] **Step 4: Write the compare service.** `api/internal/compare/service.go`:

```go
// Package compare composes a user's habit metrics with those of their
// sharing friends. The consent gate lives here: a friend's metrics are only
// computed when their ShareProgress is true.
package compare

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/progress"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

type friendSource interface {
	ListAcceptedForCompare(ctx context.Context, userID uuid.UUID) ([]social.CompareRow, error)
}

type userSource interface {
	ByID(ctx context.Context, id uuid.UUID) (user.User, error)
}

type Service struct {
	friends friendSource
	users   userSource
	logs    progress.LogSource
}

func NewService(friends friendSource, users userSource, logs progress.LogSource) Service {
	return Service{friends: friends, users: users, logs: logs}
}

type FriendProgress struct {
	ID            uuid.UUID `json:"id"`
	DisplayName   string    `json:"display_name"`
	Sharing       bool      `json:"sharing"`
	StreakDays    *int      `json:"streak_days,omitempty"`
	AdherenceDays *int      `json:"adherence_days,omitempty"`
}

type Result struct {
	Me      progress.Metrics `json:"me"`
	Friends []FriendProgress `json:"friends"`
}

func (s Service) Compare(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (Result, error) {
	me, err := s.users.ByID(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	meMetrics, err := progress.Compute(ctx, s.logs, userID, me.TargetKcal, day, loc)
	if err != nil {
		return Result{}, err
	}
	rows, err := s.friends.ListAcceptedForCompare(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	friends := make([]FriendProgress, 0, len(rows))
	for _, row := range rows {
		fp := FriendProgress{ID: row.ID, DisplayName: row.DisplayName, Sharing: row.ShareProgress}
		if row.ShareProgress {
			m, err := progress.Compute(ctx, s.logs, row.ID, row.TargetKcal, day, loc)
			if err != nil {
				return Result{}, err
			}
			streak, adh := m.StreakDays, m.AdherenceDays
			fp.StreakDays = &streak
			fp.AdherenceDays = &adh
		}
		friends = append(friends, fp)
	}
	return Result{Me: meMetrics, Friends: friends}, nil
}
```

- [ ] **Step 5: Write the handler.** `api/internal/compare/handler.go`:

```go
package compare

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func (h Handler) Get(c *gin.Context) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	res, err := h.svc.Compare(c.Request.Context(), id, time.Now(), user.LocFromContext(c))
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	httpx.OK(c, res)
}
```

- [ ] **Step 6: Write the stub-based service+handler test.** `api/internal/compare/compare_test.go`:

```go
package compare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

type stubFriends struct{ rows []social.CompareRow }

func (s stubFriends) ListAcceptedForCompare(context.Context, uuid.UUID) ([]social.CompareRow, error) {
	return s.rows, nil
}

type stubUsers struct{ target float64 }

func (s stubUsers) ByID(context.Context, uuid.UUID) (user.User, error) {
	return user.User{TargetKcal: s.target}, nil
}

type stubLogs struct{}

func (stubLogs) LoggedDaysDesc(context.Context, uuid.UUID, time.Time, *time.Location, int) ([]string, error) {
	return []string{}, nil
}
func (stubLogs) DailyKcal(context.Context, uuid.UUID, time.Time, time.Time, *time.Location) (map[string]float64, error) {
	return map[string]float64{}, nil
}

func TestCompareGatesNonSharingFriends(t *testing.T) {
	sharerID := uuid.New()
	privateID := uuid.New()
	svc := NewService(
		stubFriends{rows: []social.CompareRow{
			{ID: sharerID, DisplayName: "Sharer", ShareProgress: true, TargetKcal: 2000},
			{ID: privateID, DisplayName: "Private", ShareProgress: false, TargetKcal: 2000},
		}},
		stubUsers{target: 2000},
		stubLogs{},
	)
	res, err := svc.Compare(context.Background(), uuid.New(), time.Now(), time.UTC)
	require.NoError(t, err)
	require.Len(t, res.Friends, 2)

	byName := map[string]FriendProgress{}
	for _, f := range res.Friends {
		byName[f.DisplayName] = f
	}
	require.True(t, byName["Sharer"].Sharing)
	require.NotNil(t, byName["Sharer"].StreakDays) // metrics present for sharer
	require.False(t, byName["Private"].Sharing)
	require.Nil(t, byName["Private"].StreakDays) // NEVER computed for non-sharer
	require.Nil(t, byName["Private"].AdherenceDays)
}

func TestCompareHandlerShape(t *testing.T) {
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, stubLogs{})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() })
	r.GET("/v1/friends/progress", NewHandler(svc).Get)

	req := httptest.NewRequest(http.MethodGet, "/v1/friends/progress", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Me struct {
				AdherenceWindow int `json:"adherence_window"`
			} `json:"me"`
			Friends []any `json:"friends"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, 7, body.Data.Me.AdherenceWindow)
}
```

- [ ] **Step 7: Wire the route in `server/router.go`.**

Refactor the existing social wiring to reuse a repo var, then add compare. Replace the single line
`socialHandler := social.NewHandler(social.NewService(social.NewRepository(deps.DB), userRepo))`
with:
```go
			socialRepo := social.NewRepository(deps.DB)
			socialHandler := social.NewHandler(social.NewService(socialRepo, userRepo))
```
Then, after the existing `v1.GET("/friends/code", socialHandler.Code)` line, add:
```go
			compareHandler := compare.NewHandler(compare.NewService(socialRepo, userRepo, logRepo))
			v1.GET("/friends/progress", compareHandler.Get)
```
Add `"github.com/tesserix/kora/api/internal/compare"` to the imports. (`logRepo` is already defined earlier in the block as `foodlog.NewRepository(deps.DB)`; `userRepo` too.)

- [ ] **Step 8: Run all + build**

Run (from `api/`): `TEST_DATABASE_URL=…/kora_test?sslmode=disable go test -race -p 1 -count=1 ./... && go build ./...`
Expected: whole suite green (incl. new social + compare tests); build clean (confirms `/friends/progress` GET coexists with the other `/friends*` routes).

- [ ] **Step 9: Commit**
```bash
git add api/internal/social/repository.go api/internal/social/compare_rows_test.go api/internal/compare/service.go api/internal/compare/handler.go api/internal/compare/compare_test.go api/internal/server/router.go
git commit -m "feat(compare): friends progress endpoint behind consent gate"
```

---

### Task 4: Mobile types + hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces: types `ProgressView`, `FriendProgress`, `FriendsProgress`; `Profile.share_progress`; hooks `useFriendsProgress()`, `useSetShareProgress()`.

- [ ] **Step 1: Failing tests.** Append to `hooks.test.tsx` (add the two hook names to the `"../hooks"` import):

```tsx
test("useFriendsProgress GETs /v1/friends/progress", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ me: { streak_days: 3, adherence_days: 4, adherence_window: 7 }, friends: [] });
  const { result } = await renderHook(() => useFriendsProgress(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/progress");
});

test("useSetShareProgress PATCHes /v1/me/share-progress with the flag", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ share_progress: true });
  const { result } = await renderHook(() => useSetShareProgress(), { wrapper });
  result.current.mutate(true);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/me/share-progress", {
    method: "PATCH",
    body: JSON.stringify({ share_progress: true }),
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci hooks.test` → FAIL (hooks undefined).

- [ ] **Step 3: Types.** In `types.ts`, add `share_progress: boolean;` to the `Profile` type, and append:

```ts
export interface ProgressView {
  streak_days: number;
  adherence_days: number;
  adherence_window: number;
}

export interface FriendProgress {
  id: string;
  display_name: string;
  sharing: boolean;
  streak_days?: number;
  adherence_days?: number;
}

export interface FriendsProgress {
  me: ProgressView;
  friends: FriendProgress[];
}
```

- [ ] **Step 4: Hooks.** In `hooks.ts`, add `FriendsProgress` to the type import from `"./types"`, then append:

```ts
export function useFriendsProgress() {
  return useQuery({
    queryKey: ["friends-progress"],
    queryFn: () => apiFetch("/v1/friends/progress") as Promise<FriendsProgress>,
  });
}

export function useSetShareProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (share_progress: boolean) =>
      apiFetch("/v1/me/share-progress", { method: "PATCH", body: JSON.stringify({ share_progress }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["friends-progress"] });
    },
  });
}
```

- [ ] **Step 5: Run to verify pass** — `npm test -- --ci hooks.test && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): friends-progress + share-progress hooks"
```

---

### Task 5: `FriendsLeaderboard` component

**Files:**
- Create: `apps/mobile/src/components/social/FriendsLeaderboard.tsx`
- Test: `apps/mobile/src/components/social/__tests__/FriendsLeaderboard.test.tsx`

**Interfaces:**
- Consumes: `FriendsProgress` type. Produces: `FriendsLeaderboard({ data }: { data?: FriendsProgress })`.

- [ ] **Step 1: Failing test.** `FriendsLeaderboard.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { FriendsLeaderboard } from "../FriendsLeaderboard";

const data = {
  me: { streak_days: 5, adherence_days: 4, adherence_window: 7 },
  friends: [
    { id: "a", display_name: "Ada", sharing: true, streak_days: 9, adherence_days: 6 },
    { id: "b", display_name: "Ben", sharing: false },
  ],
};

test("ranks by streak, shows on-target, and groups non-sharing", async () => {
  const { getByText, queryByText, getAllByText } = await render(<FriendsLeaderboard data={data} />);
  expect(getByText("You")).toBeTruthy();
  expect(getByText("Ada")).toBeTruthy();
  // Ada (streak 9) ranks above You (streak 5): rank labels present
  expect(getByText("4/7 on target")).toBeTruthy(); // your adherence
  expect(getByText("6/7 on target")).toBeTruthy(); // Ada's adherence
  // Ben is non-sharing -> under "Not sharing", no on-target line
  expect(getByText("Not sharing")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci FriendsLeaderboard` → FAIL (missing file).

- [ ] **Step 3: Write the component.** `FriendsLeaderboard.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Numeral } from "@/components/Numeral";
import { useTheme } from "@/theme";
import type { FriendsProgress } from "@/api/types";

interface Props {
  data?: FriendsProgress;
}

interface Rankable {
  id: string;
  name: string;
  me: boolean;
  streak: number;
  adherence: number;
}

export function FriendsLeaderboard({ data }: Props) {
  const { colors, radius } = useTheme();
  if (!data) return null;

  const window = data.me.adherence_window;
  const sharing = data.friends.filter((f) => f.sharing);
  const notSharing = data.friends.filter((f) => !f.sharing);

  const ranked: Rankable[] = [
    { id: "me", name: "You", me: true, streak: data.me.streak_days, adherence: data.me.adherence_days },
    ...sharing.map((f) => ({
      id: f.id,
      name: f.display_name,
      me: false,
      streak: f.streak_days ?? 0,
      adherence: f.adherence_days ?? 0,
    })),
  ].sort((a, b) => b.streak - a.streak || b.adherence - a.adherence);

  return (
    <View style={{ gap: 10 }}>
      <Overline>Leaderboard</Overline>
      {ranked.map((r, i) => (
        <View
          key={r.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            padding: 14,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: r.me ? colors.primary : colors.border,
            backgroundColor: colors.card,
          }}
        >
          <Numeral size={14} color={colors.mutedForeground}>{String(i + 1)}</Numeral>
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 15, fontWeight: r.me ? "700" : "600" }}>{r.name}</AppText>
            <AppText muted style={{ fontSize: 12 }}>{`${r.adherence}/${window} on target`}</AppText>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Numeral size={16}>{String(r.streak)}</Numeral>
            <AppText muted style={{ fontSize: 11 }}>day streak</AppText>
          </View>
        </View>
      ))}

      {notSharing.length > 0 ? (
        <View style={{ gap: 8, marginTop: 6 }}>
          <Overline>Not sharing</Overline>
          {notSharing.map((f) => (
            <AppText key={f.id} muted style={{ fontSize: 14, paddingHorizontal: 4 }}>{f.display_name}</AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: Run to verify pass + typecheck** — `npm test -- --ci FriendsLeaderboard && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/src/components/social/FriendsLeaderboard.tsx apps/mobile/src/components/social/__tests__/FriendsLeaderboard.test.tsx
git commit -m "feat(mobile): FriendsLeaderboard component"
```

---

### Task 6: Friends-screen wiring (share toggle + leaderboard)

**Files:**
- Modify: `apps/mobile/app/friends.tsx`
- Modify: `apps/mobile/app/__tests__/friends.test.tsx` (extend mock + add a toggle test)

**Interfaces:**
- Consumes: `useProfile`, `useSetShareProgress`, `useFriendsProgress` (Task 4), `FriendsLeaderboard` (Task 5).

- [ ] **Step 1: Failing test.** In `friends.test.tsx`, extend the `@/api/hooks` mock to add the three hooks, and add a toggle test.

Add to the `jest.mock("@/api/hooks", …)` factory object (alongside the existing friend hooks):
```tsx
  useProfile: () => ({ data: { share_progress: false } }),
  useSetShareProgress: () => ({ mutate: mockSetShareMutate, isPending: false }),
  useFriendsProgress: () => ({ data: { me: { streak_days: 2, adherence_days: 1, adherence_window: 7 }, friends: [] } }),
```
Declare `const mockSetShareMutate = jest.fn();` with the other mock vars, and `mockSetShareMutate.mockClear();` in `beforeEach`. Then append:

```tsx
test("toggling Share my progress calls useSetShareProgress with the new value", async () => {
  const { getByLabelText } = await render(<Friends />);
  await fireEvent(getByLabelText("Share my progress"), "valueChange", true);
  expect(mockSetShareMutate).toHaveBeenCalledWith(true);
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci friends.test` → FAIL (no "Share my progress" switch).

- [ ] **Step 3: Wire the screen.** In `apps/mobile/app/friends.tsx`:

Add imports:
```tsx
import { Switch } from "react-native";
import { FriendsLeaderboard } from "@/components/social/FriendsLeaderboard";
import { useProfile, useSetShareProgress, useFriendsProgress } from "@/api/hooks";
```
(Merge the hook names into the existing `@/api/hooks` import line rather than duplicating it.)

Inside the component, add:
```tsx
  const profile = useProfile();
  const setShare = useSetShareProgress();
  const compare = useFriendsProgress();
  const shareOn = profile.data?.share_progress ?? false;
```

In the JSX, directly under the "Add a friend" button (before the requests section), add the toggle + leaderboard:
```tsx
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 }}>
            <View style={{ flex: 1 }}>
              <AppText style={{ fontSize: 15, fontWeight: "600" }}>Share my progress</AppText>
              <AppText muted style={{ fontSize: 12 }}>Friends can see your streak and on-target days.</AppText>
            </View>
            <Switch
              accessibilityLabel="Share my progress"
              value={shareOn}
              onValueChange={(v) => setShare.mutate(v)}
            />
          </View>

          <FriendsLeaderboard data={compare.data} />
```

- [ ] **Step 4: Run to verify pass + full suite + typecheck**

Run (from `apps/mobile/`): `npm test -- --ci friends.test && npx tsc --noEmit && npm test -- --ci`
Expected: PASS; whole suite green.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/app/friends.tsx apps/mobile/app/__tests__/friends.test.tsx
git commit -m "feat(mobile): share toggle + leaderboard on the Friends screen"
```

---

## Final verification (after all tasks)

- [ ] Backend: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./... && go build ./...` — green.
- [ ] Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` — green.
- [ ] Final whole-branch review of the feature commits on the most capable model before READY TO MERGE. Pay special attention to the **consent gate** — assert no code path serializes a non-sharing friend's metrics.
- [ ] Do NOT push until the user approves.

## Notes for implementers
- Stale RED LSP diagnostics after a test-before-impl step are normal on Go — verify with `go build ./...` / `go test`.
- `progress.Compute` and `compare.Service` take interfaces specifically so their logic is unit-tested with in-memory stubs (no DB). Only `DailyKcal` and `ListAcceptedForCompare` (the two new SQL queries) get DB tests.
- The `Switch` test fires the `"valueChange"` event: `fireEvent(getByLabelText("Share my progress"), "valueChange", true)`.
