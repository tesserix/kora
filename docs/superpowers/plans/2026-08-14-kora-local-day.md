# Local Day Per Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the local calendar date on each food/water/weight row at capture time and query days by it, so changing a user's timezone can never re-bucket their history.

**Architecture:** A new `local_date DATE NOT NULL` column on `food_logs`, `water_entries` and `weight_entries`, backfilled from each user's profile timezone (which reproduces today's bucketing exactly). The client supplies the date at capture time — forced by the offline queue, which replays writes hours later and possibly in a different zone. The server validates it against `logged_at` and falls back to the profile zone when the field is absent, so already-installed builds keep working. Day-scoped reads then filter on the column and stop taking a `*time.Location`.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL, golang-migrate; React Native / Expo (TypeScript), Jest + React Native Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-14-kora-local-day-design.md`

## Global Constraints

- Migration pair is `000032_local_day.up.sql` / `000032_local_day.down.sql` in `api/internal/database/migrations/`. `000031` is already taken by `food_logs_portion_assumed`.
- `local_date` is a SQL `DATE`, JSON `local_date`, Go `string` in requests (`"YYYY-MM-DD"`) and `time.Time` on models.
- Client date format is `en-CA` (`new Date().toLocaleDateString("en-CA")`) — this yields `YYYY-MM-DD` and is already the convention in `apps/mobile/app/(tabs)/diary.tsx:43` and `apps/mobile/src/offline/useQueuedLogs.ts`.
- Validation window is **±1 day** from `logged_at` evaluated in UTC. Outside that → `httpx.ValidationError`. Absent → fall back to profile zone, NOT an error.
- `user.LocFromContext` must remain in use for challenges, coach, memory, `compare` and `groups`. Do not touch those; they are explicitly out of scope.
- Go tests: `cd api && set -a && . ./.env && set +a && go test ./internal/<pkg>/...`. `go test ./...` truncates dev `food_items`; re-seed with `go run ./cmd/seed` if you run the full suite.
- Mobile tests: `cd apps/mobile && npx jest <path> --forceExit`. Single-file runs hang ~300s on open handles without `--forceExit`.
- `fireEvent` and `render`/`renderHook` MUST be awaited (RNTL 14 + React 19) or assertions pass against un-flushed state.
- Single-line conventional commits, no body, no signature.

---

### Task 1: Migration — add and backfill `local_date`

**Files:**
- Create: `api/internal/database/migrations/000032_local_day.up.sql`
- Create: `api/internal/database/migrations/000032_local_day.down.sql`
- Test: `api/internal/database/migrations_local_day_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `food_logs.local_date`, `water_entries.local_date`, `weight_entries.local_date`, all `DATE NOT NULL`; indexes `idx_food_logs_user_local_date`, `idx_water_entries_user_local_date`, `idx_weight_entries_user_local_date` on `(user_id, local_date)`.

- [ ] **Step 1: Write the failing test**

Create `api/internal/database/migrations_local_day_test.go`:

```go
package database

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The backfill must reproduce the bucketing the current code produces, which
// is what makes NOT NULL safe on day one. A log at 2026-03-01T12:00:00Z for a
// Sydney user is 2026-03-01 local (UTC+11); the same instant for a Los Angeles
// user is 2026-02-28 local (UTC-8). If the backfill used UTC or server-local
// time instead of the profile zone, the LA row would be wrong.
func TestLocalDayBackfillUsesProfileTimezone(t *testing.T) {
	db := testDB(t) // existing helper in api/internal/database/migrations_test.go

	var sydney, la string
	require.NoError(t, db.Raw(`
		SELECT (TIMESTAMPTZ '2026-03-01 12:00:00Z' AT TIME ZONE 'Australia/Sydney')::date::text
	`).Scan(&sydney).Error)
	require.NoError(t, db.Raw(`
		SELECT (TIMESTAMPTZ '2026-03-01 12:00:00Z' AT TIME ZONE 'America/Los_Angeles')::date::text
	`).Scan(&la).Error)

	require.Equal(t, "2026-03-01", sydney)
	require.Equal(t, "2026-02-28", la)
}

func TestLocalDayColumnsExistAndAreNotNull(t *testing.T) {
	db := testDB(t)

	for _, table := range []string{"food_logs", "water_entries", "weight_entries"} {
		var isNullable string
		err := db.Raw(`
			SELECT is_nullable FROM information_schema.columns
			WHERE table_name = ? AND column_name = 'local_date'
		`, table).Scan(&isNullable).Error
		require.NoError(t, err, table)
		require.Equal(t, "NO", isNullable, "%s.local_date must be NOT NULL", table)
	}

	var indexes int
	require.NoError(t, db.Raw(`
		SELECT count(*) FROM pg_indexes
		WHERE indexname IN (
			'idx_food_logs_user_local_date',
			'idx_water_entries_user_local_date',
			'idx_weight_entries_user_local_date'
		)
	`).Scan(&indexes).Error)
	require.Equal(t, 3, indexes)
}
```

`testDB(t *testing.T) *gorm.DB` already exists in `api/internal/database/migrations_test.go` (`package database`). Use it as-is; do not add a second harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/database/... -run TestLocalDay -v`
Expected: FAIL — `local_date` column does not exist, so `is_nullable` scans empty and the index count is 0.

- [ ] **Step 3: Write the migration**

`000032_local_day.up.sql`:

```sql
-- kora#84. A log's day is a fact about when it was eaten, decided once at
-- capture. Previously the day boundary was derived at QUERY time from the
-- user's CURRENT profile timezone, so changing that timezone silently
-- re-bucketed all history.
--
-- The backfill uses the profile timezone because that is exactly what the old
-- query-time logic used, so existing rows land in the same buckets they
-- already appear in. Zero visible change to existing data — which is what
-- makes SET NOT NULL safe here rather than a nullable column plus a fallback
-- path maintained forever.

ALTER TABLE food_logs ADD COLUMN local_date DATE;
ALTER TABLE water_entries ADD COLUMN local_date DATE;
ALTER TABLE weight_entries ADD COLUMN local_date DATE;

UPDATE food_logs fl
SET local_date = (fl.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = fl.user_id;

UPDATE water_entries we
SET local_date = (we.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = we.user_id;

UPDATE weight_entries we
SET local_date = (we.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = we.user_id;

-- Any row whose user vanished cannot be bucketed from a profile zone. Fall
-- back to UTC rather than leaving a NULL that blocks SET NOT NULL.
UPDATE food_logs SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;
UPDATE water_entries SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;
UPDATE weight_entries SET local_date = (logged_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;

ALTER TABLE food_logs ALTER COLUMN local_date SET NOT NULL;
ALTER TABLE water_entries ALTER COLUMN local_date SET NOT NULL;
ALTER TABLE weight_entries ALTER COLUMN local_date SET NOT NULL;

CREATE INDEX idx_food_logs_user_local_date ON food_logs (user_id, local_date);
CREATE INDEX idx_water_entries_user_local_date ON water_entries (user_id, local_date);
CREATE INDEX idx_weight_entries_user_local_date ON weight_entries (user_id, local_date);
```

`000032_local_day.down.sql`:

```sql
DROP INDEX IF EXISTS idx_food_logs_user_local_date;
DROP INDEX IF EXISTS idx_water_entries_user_local_date;
DROP INDEX IF EXISTS idx_weight_entries_user_local_date;

ALTER TABLE food_logs DROP COLUMN IF EXISTS local_date;
ALTER TABLE water_entries DROP COLUMN IF EXISTS local_date;
ALTER TABLE weight_entries DROP COLUMN IF EXISTS local_date;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/database/... -run TestLocalDay -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/internal/database/migrations/000032_local_day.up.sql api/internal/database/migrations/000032_local_day.down.sql api/internal/database/migrations_local_day_test.go
git commit -m "feat(api): add a per-row local_date backfilled from each user's profile timezone"
```

---

### Task 2: Model fields and the resolver that decides a row's local date

**Files:**
- Modify: `api/internal/foodlog/model.go`
- Modify: `api/internal/tracking/model.go`
- Create: `api/internal/localday/localday.go`
- Test: `api/internal/localday/localday_test.go`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  - `localday.Resolve(clientDate string, loggedAt time.Time, loc *time.Location) (time.Time, error)` — returns the date to persist. Empty `clientDate` falls back to `loggedAt.In(loc)` truncated to a day. A malformed or out-of-window value returns `httpx.ValidationError`.
  - `foodlog.FoodLog.LocalDate time.Time` with `gorm:"type:date;not null" json:"local_date"`.
  - `tracking.WaterEntry.LocalDate` and `tracking.WeightEntry.LocalDate`, same tags.

- [ ] **Step 1: Write the failing test**

Create `api/internal/localday/localday_test.go`:

```go
package localday_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/localday"
)

func sydney(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Australia/Sydney")
	require.NoError(t, err)
	return loc
}

// Absent is NOT invalid. An already-installed build sends no local_date, and
// must keep working exactly as before rather than have every write rejected.
func TestResolveFallsBackToProfileZoneWhenAbsent(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC) // 23:00 in Sydney
	got, err := localday.Resolve("", loggedAt, sydney(t))
	require.NoError(t, err)
	require.Equal(t, "2026-03-01", got.Format("2006-01-02"))
}

// The whole point of the change: the client's value WINS over what the server
// would have computed. This is the test that fails if someone later
// "simplifies" this to server-side computation.
func TestResolvePrefersClientDateOverProfileZone(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	// Device was in Los Angeles: 2026-02-28 local, though Sydney says 03-01.
	got, err := localday.Resolve("2026-02-28", loggedAt, sydney(t))
	require.NoError(t, err)
	require.Equal(t, "2026-02-28", got.Format("2006-01-02"))
}

// ±1 day is the legitimate range: no single UTC date is "correct", because a
// real timezone can put the local date either side of it.
func TestResolveAcceptsExactlyOneDayEitherSide(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	for _, in := range []string{"2026-02-28", "2026-03-01", "2026-03-02"} {
		got, err := localday.Resolve(in, loggedAt, sydney(t))
		require.NoError(t, err, in)
		require.Equal(t, in, got.Format("2006-01-02"))
	}
}

func TestResolveRejectsOutOfWindowDate(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	_, err := localday.Resolve("2026-03-09", loggedAt, sydney(t))
	require.Error(t, err)
}

func TestResolveRejectsMalformedDate(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	_, err := localday.Resolve("01/03/2026", loggedAt, sydney(t))
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/localday/... -v`
Expected: FAIL — package `localday` does not exist.

- [ ] **Step 3: Write the implementation**

Create `api/internal/localday/localday.go`:

```go
// Package localday resolves which calendar day a logged row belongs to.
//
// kora#84: the day used to be derived at QUERY time from the user's current
// profile timezone, so changing that timezone re-bucketed history. The day is
// now decided once, here, at write time.
package localday

import (
	"fmt"
	"time"

	"github.com/tesserix/kora/api/internal/httpx"
)

const layout = "2006-01-02"

// window is how far a client-supplied date may sit from logged_at's UTC date.
// One day either side, because a real timezone legitimately puts the local
// date on either side of the UTC one. Anything wider is not a timezone.
const window = 24 * time.Hour

// Resolve returns the calendar date to persist for a row logged at loggedAt.
//
// clientDate is the device-local date captured at the moment of logging. It is
// preferred over anything the server could compute, because the offline queue
// replays writes later and possibly from another zone — a meal captured in
// London and replayed in Sydney must keep London's date.
//
// An EMPTY clientDate is not an error: it means an older client, and falls
// back to the profile zone, which is exactly the previous behaviour.
func Resolve(clientDate string, loggedAt time.Time, loc *time.Location) (time.Time, error) {
	if loc == nil {
		loc = time.UTC
	}
	if clientDate == "" {
		local := loggedAt.In(loc)
		return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC), nil
	}

	parsed, err := time.ParseInLocation(layout, clientDate, time.UTC)
	if err != nil {
		return time.Time{}, httpx.ValidationError{
			Message: fmt.Sprintf("local_date must be YYYY-MM-DD, got %q", clientDate),
		}
	}

	utcDay := loggedAt.UTC().Truncate(24 * time.Hour)
	if diff := parsed.Sub(utcDay); diff > window || diff < -window {
		return time.Time{}, httpx.ValidationError{
			Message: "local_date is too far from logged_at to be a real timezone",
		}
	}
	return parsed, nil
}
```

Then add the model fields.

In `api/internal/foodlog/model.go`, inside the `FoodLog` struct, immediately after the `LoggedAt` field:

```go
	// LocalDate is the calendar day this log belongs to, in the device's zone
	// at the moment of capture. Decided once at write time and never derived
	// from the profile timezone at read time — see kora#84 and
	// internal/localday.
	LocalDate time.Time `gorm:"type:date;not null" json:"local_date"`
```

In `api/internal/tracking/model.go`, add the identical field (same comment) to both `WaterEntry` and `WeightEntry`, after each one's `LoggedAt`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/localday/... ./internal/foodlog/... ./internal/tracking/... -v 2>&1 | tail -20`
Expected: `localday` PASSes. `foodlog` and `tracking` still compile and pass — the new field is populated by Task 3, so any pre-existing test that inserts a row directly may now fail the NOT NULL constraint. If so, that is Task 3's job; note it and continue.

- [ ] **Step 5: Commit**

```bash
git add api/internal/localday/ api/internal/foodlog/model.go api/internal/tracking/model.go
git commit -m "feat(api): resolve a row's local day from the client, falling back to the profile zone"
```

---

### Task 3: Write paths persist the local date

**Files:**
- Modify: `api/internal/foodlog/service.go` (`LogRequest` struct ~line 55, `LogFood` ~line 178)
- Modify: `api/internal/tracking/repository.go` (`AddWater` ~line 22, `AddWeight` ~line 52)
- Modify: `api/internal/tracking/handler.go`
- Test: `api/internal/foodlog/localday_write_test.go`

**Interfaces:**
- Consumes: `localday.Resolve` from Task 2; the model fields from Task 2.
- Produces: `LogRequest.LocalDate string` (`json:"local_date"`). `tracking.Repository.AddWater(ctx, userID, volumeML, at, localDate)` and `AddWeight(ctx, userID, weightKg, at, localDate)` both gain a trailing `localDate time.Time`.

- [ ] **Step 1: Write the failing test**

Create `api/internal/foodlog/localday_write_test.go`:

```go
package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// seedFoodItemFor inserts a known food and returns its id. The existing suite
// builds items inline (see service_test.go); this wraps that so the local-day
// tests stay about dates.
func seedFoodItemFor(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "Local Day " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item.ID
}

// setUserTimezone sets the profile zone. seedUser inserts a bare row, so the
// column carries its SQL default until this runs.
func setUserTimezone(t *testing.T, db *gorm.DB, userID uuid.UUID, tz string) {
	t.Helper()
	require.NoError(t, db.Exec("UPDATE users SET timezone = ? WHERE id = ?", tz, userID).Error)
}

// The client's date must survive to the database unchanged, even when the
// server's profile zone would have produced a different one. If this test
// fails, the offline queue is filing replayed meals on the wrong day.
func TestLogFoodPersistsClientLocalDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		LocalDate:     "2026-02-28", // device was in Los Angeles
	})
	require.NoError(t, err)
	require.Equal(t, "2026-02-28", log.LocalDate.Format("2006-01-02"))
}

func TestLogFoodFallsBackToProfileZoneWhenClientOmitsDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC), // 23:00 Sydney
	})
	require.NoError(t, err)
	require.Equal(t, "2026-03-01", log.LocalDate.Format("2006-01-02"))
}

func TestLogFoodRejectsOutOfWindowLocalDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "lunch",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		LocalDate:     "2026-03-09",
	})
	require.Error(t, err)
}
```

These use the suite's existing `testDB(t *testing.T) *gorm.DB` and `seedUser(t *testing.T, db *gorm.DB) uuid.UUID` from `api/internal/foodlog/service_test.go`, plus the two small helpers defined above. Note the package is `foodlog`, not `foodlog_test` — the whole suite is internal, which is why `LogRequest` and `NewService` are unqualified.

`LogFood` needs the user's `*time.Location` for the fallback. Read how the service already obtains user data (`grep -n "loc\|Location\|timezone" api/internal/foodlog/service.go`) and thread it the same way — if the service has no access, pass `*time.Location` as a new trailing parameter to `LogFood` and have `Handler.Create` supply `user.LocFromContext(c)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/foodlog/... -run TestLogFood -v`
Expected: FAIL — `LogRequest` has no `LocalDate` field, so this does not compile.

- [ ] **Step 3: Write the implementation**

In `api/internal/foodlog/service.go`, add to `LogRequest` after `ClientLogMs`:

```go
	// LocalDate is the device-local calendar day at the moment of capture,
	// "YYYY-MM-DD". Sent by the client rather than computed here because the
	// offline queue replays writes later and possibly from another timezone —
	// a meal captured in London and replayed in Sydney keeps London's date.
	// Empty means an older client; internal/localday falls back to the
	// profile zone, which is the previous behaviour. See kora#84.
	LocalDate string `json:"local_date"`
```

In `LogFood`, after the existing `loggedAt` block:

```go
	localDate, err := localday.Resolve(req.LocalDate, loggedAt, loc)
	if err != nil {
		return FoodLog{}, err
	}
```

and add `LocalDate: localDate,` to the `FoodLog{...}` literal, directly after `LoggedAt: loggedAt,`.

Apply the same three changes to `CreateBatch` (same file) so batch writes are not a hole in the validation.

In `api/internal/tracking/repository.go`, give both writers the resolved date:

```go
func (r Repository) AddWater(ctx context.Context, userID uuid.UUID, volumeML int, at time.Time, localDate time.Time) (WaterEntry, error) {
	if volumeML <= 0 {
		return WaterEntry{}, httpx.ValidationError{Message: "volume_ml must be positive"}
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WaterEntry{UserID: userID, VolumeML: volumeML, LoggedAt: at, LocalDate: localDate}
	...
}
```

`AddWeight` takes the same trailing parameter and sets `LocalDate: localDate` on `WeightEntry` the same way.

In `api/internal/tracking/handler.go`, each caller resolves before calling:

```go
	localDate, err := localday.Resolve(req.LocalDate, at, user.LocFromContext(c))
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
```

adding a `LocalDate string \`json:"local_date"\`` field to the water and weight request structs in that file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/foodlog/... ./internal/tracking/... -v 2>&1 | tail -20`
Expected: PASS. Pre-existing tests that insert rows directly may need `LocalDate` added — fix them by setting a real date, never by making the column nullable.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog/service.go api/internal/foodlog/localday_write_test.go api/internal/tracking/repository.go api/internal/tracking/handler.go
git commit -m "feat(api): persist the client's local day on food, water and weight writes"
```

---

### Task 4: Read paths query by `local_date`

**Files:**
- Modify: `api/internal/foodlog/repository.go` (`ListByUserAndDay` ~line 121)
- Modify: `api/internal/tracking/repository.go` (`WaterTotalForDay` ~line 36)
- Modify: `api/internal/dashboard/service.go` (`ForDay` ~line 43)
- Modify: `api/internal/foodlog/service.go` (`CopyDay`)
- Modify: `api/internal/foodlog/handler.go:81`, `api/internal/foodlog/handler.go:186`, `api/internal/dashboard/handler.go:37`, `api/internal/tracking/handler.go:64`
- Test: `api/internal/foodlog/localday_read_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: `ListByUserAndDay(ctx, userID, day time.Time) ([]FoodLog, error)`, `WaterTotalForDay(ctx, userID, day time.Time) (int, error)`, `ForDay(ctx, userID, day time.Time) (Summary, error)` — all with the `loc *time.Location` parameter **removed**.

- [ ] **Step 1: Write the failing test**

Create `api/internal/foodlog/localday_read_test.go`:

```go
package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// The motivating regression: a log's day must not move when the user's profile
// timezone changes. Before kora#84 this test would fail — the day boundary was
// recomputed at read time from whatever the profile said now.
func TestListByDayDoesNotMoveWhenProfileTimezoneChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	setUserTimezone(t, db, userID, "Australia/Sydney")
	itemID := seedFoodItemFor(t, db)
	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))

	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID:    &itemID,
		MealSlot:      "dinner",
		QuantityGrams: 100,
		LoggedAt:      time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		LocalDate:     "2026-03-01",
	})
	require.NoError(t, err)

	day := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

	before, err := repo.ListByUserAndDay(context.Background(), userID, day)
	require.NoError(t, err)
	require.Len(t, before, 1)

	setUserTimezone(t, db, userID, "America/Los_Angeles")

	after, err := repo.ListByUserAndDay(context.Background(), userID, day)
	require.NoError(t, err)
	require.Len(t, after, 1, "changing the profile timezone must not re-bucket history")
}
```

`setUserTimezone` and `seedFoodItemFor` are the helpers added in Task 3's test file; they live in the same package, so reuse them rather than redefining.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && set -a && . ./.env && set +a && go test ./internal/foodlog/... -run TestListByDayDoesNotMove -v`
Expected: FAIL to compile — `ListByUserAndDay` still takes four arguments.

- [ ] **Step 3: Write the implementation**

`api/internal/foodlog/repository.go`:

```go
// ListByUserAndDay returns logs whose local_date is `day`.
//
// Filters on the stored local_date rather than deriving a window from the
// user's current profile timezone: the day a log belongs to is fixed at
// capture and must not move when the profile changes. See kora#84.
func (r Repository) ListByUserAndDay(ctx context.Context, userID uuid.UUID, day time.Time) ([]FoodLog, error) {
	var logs []FoodLog
	err := r.withFoodUnit(ctx).
		Where("food_logs.user_id = ? AND food_logs.local_date = ?", userID, day.Format("2006-01-02")).
		Order("food_logs.logged_at ASC").
		Find(&logs).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: list by day: %w", err)
	}
	return logs, nil
}
```

`api/internal/tracking/repository.go`:

```go
func (r Repository) WaterTotalForDay(ctx context.Context, userID uuid.UUID, day time.Time) (int, error) {
	var total *int
	err := r.db.WithContext(ctx).Model(&WaterEntry{}).
		Where("user_id = ? AND local_date = ?", userID, day.Format("2006-01-02")).
		Select("COALESCE(SUM(volume_ml), 0)").Scan(&total).Error
	if err != nil {
		return 0, fmt.Errorf("tracking: water total: %w", err)
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}
```

`dashboard.Service.ForDay` drops its `loc` parameter and calls `s.logs.ListByUserAndDay(ctx, userID, day)`. `foodlog.Service.CopyDay` drops `loc` the same way.

Update the four call sites to stop passing `user.LocFromContext(c)`:
- `api/internal/foodlog/handler.go:81` and `:186`
- `api/internal/dashboard/handler.go:37`
- `api/internal/tracking/handler.go:64`

Do NOT remove `user.LocFromContext` itself, and do not touch its use in `challenges`, `coach`, `memory`, `compare` or `groups`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && set -a && . ./.env && set +a && go build ./... && go test ./internal/foodlog/... ./internal/tracking/... ./internal/dashboard/... -v 2>&1 | tail -20`
Expected: PASS, and `go build ./...` clean — the signature change ripples, so a missed call site shows up here.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog/ api/internal/tracking/ api/internal/dashboard/
git commit -m "feat(api): bucket days by the stored local date instead of the current profile timezone"
```

---

### Task 5: Client sends its local date on every write

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (`OnboardingInput` ~line 228; the log-create payload type)
- Modify: `apps/mobile/src/api/hooks.ts` (`useCreateLog`, `useCreateLogBatch`, `useAddWater`, `useAddWeight`)
- Modify: `apps/mobile/app/onboarding.tsx`
- Test: `apps/mobile/src/api/__tests__/localDate.test.tsx`

**Interfaces:**
- Consumes: the API from Tasks 3–4.
- Produces: `localDateNow(): string` exported from `apps/mobile/src/lib/localDate.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/api/__tests__/localDate.test.tsx`:

```tsx
import { localDateNow } from "@/lib/localDate";

// en-CA yields YYYY-MM-DD, which is what the server parses and what
// app/(tabs)/diary.tsx and src/offline/useQueuedLogs.ts already use. A
// different locale here would silently send DD/MM/YYYY and every write would
// be rejected as malformed.
test("localDateNow returns an ISO calendar date", () => {
  expect(localDateNow()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("localDateNow uses the device zone, not UTC", () => {
  const spy = jest
    .spyOn(Date.prototype, "toLocaleDateString")
    .mockReturnValue("2026-02-28");
  expect(localDateNow()).toBe("2026-02-28");
  expect(spy).toHaveBeenCalledWith("en-CA");
  spy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/api/__tests__/localDate.test.tsx --forceExit`
Expected: FAIL — cannot resolve `@/lib/localDate`.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/src/lib/localDate.ts`:

```ts
// The device-local calendar date, sent with every write so the server can file
// a log under the day the user actually experienced (kora#84).
//
// "en-CA" is what produces YYYY-MM-DD, and matches app/(tabs)/diary.tsx and
// src/offline/useQueuedLogs.ts — so a queued row and its server row agree by
// construction rather than by coincidence.
export function localDateNow(): string {
  return new Date().toLocaleDateString("en-CA");
}
```

In `apps/mobile/src/api/hooks.ts`, add `local_date: localDateNow()` to the request body of `useCreateLog`, `useCreateLogBatch`, `useAddWater` and `useAddWeight`, importing `localDateNow` from `@/lib/localDate`.

In `apps/mobile/src/api/types.ts`, add `timezone?: string;` to `OnboardingInput`, and add `local_date?: string;` to the log-create payload type.

In `apps/mobile/app/onboarding.tsx`, include the device zone in the submit payload:

```ts
timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/api --forceExit && npx tsc --noEmit`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/localDate.ts apps/mobile/src/api/ apps/mobile/app/onboarding.tsx
git commit -m "feat(mobile): send the device local date with each write and the device zone at onboarding"
```

---

### Task 6: The offline queue preserves the capture-time date

**Files:**
- Modify: `apps/mobile/src/offline/queue.ts`
- Test: `apps/mobile/src/offline/__tests__/queue-local-date.test.ts`

**Interfaces:**
- Consumes: `localDateNow` from Task 5.
- Produces: nothing new; the queued payload simply carries `local_date` through unchanged.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/offline/__tests__/queue-local-date.test.ts`:

```ts
import { append, list } from "../queue";

// THE regression this whole design exists to prevent. A meal captured in
// London and replayed after landing in Sydney must keep London's date. If the
// queue re-stamped the date at drain time, or the server computed it on
// receipt, the meal would silently move to the wrong day.
test("a queued log keeps the date it was captured with, not the date it drains", async () => {
  await append({ local_date: "2026-02-28", description: "Fish and chips" } as never, "user-1");

  const queued = await list("user-1");
  expect(queued).toHaveLength(1);
  expect((queued[0].payload as { local_date: string }).local_date).toBe("2026-02-28");
});
```

Check `append`/`list`'s real signatures first with `grep -n "export async function append\|export async function list" apps/mobile/src/offline/queue.ts` and match them exactly.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd apps/mobile && npx jest src/offline/__tests__/queue-local-date.test.ts --forceExit`
Expected: it may already PASS, because the queue stores the payload verbatim. **That is fine and is the point** — this test pins behaviour that must not regress. If it passes unchanged, add no production code; the test is the deliverable. If it fails, the queue is mutating the payload and must be changed to store it verbatim.

- [ ] **Step 3: Confirm the test can fail**

Temporarily change `queue.ts` to overwrite `local_date` with `localDateNow()` on drain, re-run, and confirm the test goes RED. Then revert that change. A test that cannot fail is worse than no test — this repo has been bitten by exactly that.

- [ ] **Step 4: Run the full mobile suite**

Run: `cd apps/mobile && npx jest --silent --forceExit`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/offline/
git commit -m "test(mobile): pin that a queued log keeps its capture-time local date through a drain"
```

---

### Task 7: End-to-end verification against the running stack

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-kora-local-day-design.md` (mark verified)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence for the kora#84 acceptance criteria.

- [ ] **Step 1: Apply the migration to the dev database**

Run: `cd api && set -a && . ./.env && set +a && go run ./cmd/migrate`
Expected: `000032` applied. Confirm: `psql "$DATABASE_URL" -tAc "select version from schema_migrations"` returns `32`.

- [ ] **Step 2: Verify the backfill preserved existing buckets**

Run:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql "$DATABASE_URL" -tAc \
  "select local_date, (logged_at AT TIME ZONE 'Australia/Sydney')::date, count(*)
   from food_logs group by 1,2"
```

Expected: the two date columns are identical on every row. A mismatch means the backfill did not reproduce the old bucketing and Task 1 is wrong.

- [ ] **Step 3: Verify a write round-trips the client's date**

Start the API (`set -a && . ./.env && set +a && go run ./cmd/api`), then from the simulator log a meal and confirm:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql "$DATABASE_URL" -tAc \
  "select description, local_date, logged_at from food_logs order by created_at desc limit 1"
```

Expected: `local_date` matches the simulator's current device date.

- [ ] **Step 4: Verify the day does not move when the timezone changes**

```bash
/opt/homebrew/opt/postgresql@18/bin/psql "$DATABASE_URL" -c \
  "update users set timezone='America/Los_Angeles' where email='mahesh.sangawar@gmail.com'"
```

Reload the diary in the simulator. The meal must stay on the same day. Then restore:

```bash
/opt/homebrew/opt/postgresql@18/bin/psql "$DATABASE_URL" -c \
  "update users set timezone='Australia/Sydney' where email='mahesh.sangawar@gmail.com'"
```

This is the acceptance criterion. Before this work the meal would move.

- [ ] **Step 5: Commit the verification note**

```bash
git add docs/superpowers/specs/2026-08-14-kora-local-day-design.md
git commit -m "docs: record local-day verification against the running stack"
```
