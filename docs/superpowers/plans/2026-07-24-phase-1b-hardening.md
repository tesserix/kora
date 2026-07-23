# Kora Phase 1b — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase 1a surface production-solid — new users never 500, infra errors never leak or masquerade as 400s, day boundaries respect the user's timezone, the streak query is O(1), and small correctness/UX gaps from review are closed.

**Architecture:** Stacks on `phase-1a-core-logging`. Introduces a `user.ResolveMiddleware` that provisions+resolves the authenticated user once per request (setting `user_id` and `user_loc` on the Gin context), collapsing the triplicated `resolveUser` boilerplate. Adds a typed validation-error path in `httpx` so services separate 400-worthy validation from 500-worthy infra failures. Adds a `timezone` column driving day-bucketing.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, testify · Expo SDK 57, RN, jest-expo · Postgres 15.

## Global Constraints

- Go 1.26; Gin; GORM; golang-migrate. Follow the committed `internal/user`, `internal/foodlog`, `internal/dashboard` patterns.
- Error envelope `{"error":"<code>","message":"<message>"}` via `httpx.Error`; success `{"data":...}` via `httpx.OK`.
- **Client-facing error messages must never contain internal/infra detail** (no wrapped DB/pg strings). Validation messages (intended, safe) may be surfaced; everything else returns a generic message with a 500.
- Every user-scoped query filters by the server-resolved `users.id` (never a client value).
- Units metric; AU-first (default timezone `Australia/Sydney`).
- Single-line conventional commits, no signatures. Immutability; error wrapping `fmt.Errorf("...: %w", err)`; no `panic` outside `main.go`.
- Mobile: TS strict, no `any`; theme tokens only; `@testing-library/react-native` v14 `render()` is **async** (`await render`). The jest script is `jest --ci --forceExit`. **Run all tests FOREGROUND** (`npm test`, `npx tsc --noEmit`, `go test ...`) — never background a test or wait on a monitor; commit before finishing.

## Context for the implementer

Current committed state (branch `phase-1a-core-logging`):
- `internal/auth/middleware.go` — `Middleware(v)` sets `c.Set("uid", claims.UID)` and `c.Set("email", claims.Email)`.
- `internal/user` — `User` (has onboarding + target columns, no timezone yet), `Repository` with `UpsertByFirebaseUID(ctx, uid, email) (User, error)` and `IDByFirebaseUID(ctx, uid) (uuid.UUID, error)`.
- `internal/foodlog/handler.go`, `internal/tracking/handler.go`, `internal/dashboard/handler.go` each have a private `resolveUser(c) (uuid.UUID, bool)` doing uid→`IDByFirebaseUID`→500-on-miss. `internal/onboarding/handler.go` inlines the same.
- `internal/foodlog/service.go` `LogFood` returns plain `fmt.Errorf` for both validation (bad meal_slot, non-positive grams, nil food_item_id) and infra (food lookup). Handlers map every service error to `400 invalid_input` with `err.Error()`.
- `internal/tracking/repository.go` `AddWater` returns `fmt.Errorf` for validation (non-positive) and infra; handler maps to 400 with `err.Error()`.
- `internal/dashboard/service.go` `streakDays` loops one `ListByUserAndDay` per day (cap 3650).
- `internal/onboarding/calc.go` `Calculate` uses inline literals (`10`, `6.25`, `5`, `161`, `2.0`, `0.25`, `9`, `4`, `120`); carb-floor `if carbsG < 0 { carbsG = 0 }` is untested.
- `internal/foodlog/handler.go` `Repeat` does `ShouldBindJSON(&req)` and 400s on empty body before the `at.IsZero()` fallback.
- `internal/nutrition/repository.go` `Insert` dedups on `name = ? AND brand = ?` only.
- `apps/mobile/app/onboarding.tsx` submits `Number(birthYear/heightCm/weightKg)` with no client validation; `TextInput`s have no `accessibilityLabel`. `apps/mobile/app/log.tsx` search + grams `TextInput`s have no `accessibilityLabel`.
- Migrations at `api/internal/database/migrations/` — last is `000002`. Next is `000003`.
- Handlers currently pass `time.UTC` to `ListByUserAndDay` / `WaterTotalForDay` / `dashboard.ForDay`.

---

### Task 1: Shared user resolution + provisioning middleware

Eliminates the new-user 500 race (non-`/me` endpoints resolving a user that only `/me` creates) and DRYs the four copies of `resolveUser`.

**Files:**
- Modify: `api/internal/user/repository.go` (add `EnsureUser`), `api/internal/user/repository_id_test.go` (add EnsureUser test) — or a new `api/internal/user/ensure_test.go`
- Create: `api/internal/user/middleware.go`, `api/internal/user/middleware_test.go`
- Modify: `api/internal/server/router.go` (mount middleware, drop per-handler user repo plumbing where now redundant)
- Modify: `api/internal/foodlog/handler.go`, `api/internal/tracking/handler.go`, `api/internal/dashboard/handler.go`, `api/internal/onboarding/handler.go` (read `user_id` from context)

**Interfaces:**
- Produces:
  - `user.Repository.EnsureUser(ctx, firebaseUID, email string) (User, error)` — SELECT by firebase_uid; if found return it; if `gorm.ErrRecordNotFound`, `UpsertByFirebaseUID` then return. Read-mostly (write only for brand-new users).
  - `user.ResolveMiddleware(repo Repository) gin.HandlerFunc` — reads `uid`/`email` from context (set by `auth.Middleware`); 401 if `uid` empty; calls `EnsureUser`; on error 500 generic; on success `c.Set("user_id", u.ID)` (a `uuid.UUID`) and continues.
  - `user.IDFromContext(c *gin.Context) (uuid.UUID, bool)` — reads `user_id`; returns `(uuid.Nil,false)` if absent.

- [ ] **Step 1: Write failing EnsureUser test** — append to `api/internal/user/repository_id_test.go`

```go
func TestEnsureUserProvisionsThenReturnsExisting(t *testing.T) {
	db := idTestDB(t)
	repo := NewRepository(db)
	fuid := "ensure-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	// First call provisions.
	u1, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev")
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, u1.ID)

	// Second call returns the same row without creating a duplicate.
	u2, err := repo.EnsureUser(context.Background(), fuid, "ensure@test.dev")
	require.NoError(t, err)
	require.Equal(t, u1.ID, u2.ID)

	var count int64
	db.Model(&User{}).Where("firebase_uid = ?", fuid).Count(&count)
	require.Equal(t, int64(1), count)
}
```

Add `"github.com/google/uuid"` / `context` imports if missing (they are already used in the file).

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/user/ -run TestEnsureUser -v`
Expected: FAIL (`EnsureUser` undefined).

- [ ] **Step 3: Implement EnsureUser** — append to `api/internal/user/repository.go`

```go
func (r Repository) EnsureUser(ctx context.Context, firebaseUID, email string) (User, error) {
	var u User
	err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&u).Error
	if err == nil {
		return u, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return User{}, fmt.Errorf("user: ensure lookup: %w", err)
	}
	return r.UpsertByFirebaseUID(ctx, firebaseUID, email)
}
```

Add `"errors"` to the import block.

- [ ] **Step 4: Run — verify pass**

Run: `cd api && go test ./internal/user/ -run TestEnsureUser -v`
Expected: PASS.

- [ ] **Step 5: Write failing middleware test** — `api/internal/user/middleware_test.go`

```go
package user

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func mwTestDB(t *testing.T) *gorm.DB {
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

func TestResolveMiddlewareSetsUserID(t *testing.T) {
	db := mwTestDB(t)
	repo := NewRepository(db)
	gin.SetMode(gin.TestMode)
	fuid := "mw-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Set("email", "mw@test.dev"); c.Next() })
	r.Use(ResolveMiddleware(repo))
	r.GET("/x", func(c *gin.Context) {
		id, ok := IDFromContext(c)
		require.True(t, ok)
		require.NotEqual(t, uuid.Nil, id)
		c.JSON(http.StatusOK, gin.H{"id": id.String()})
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestResolveMiddlewareRejectsMissingUID(t *testing.T) {
	db := mwTestDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(ResolveMiddleware(NewRepository(db)))
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/x", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}
```

- [ ] **Step 6: Run — verify fail**

Run: `cd api && go test ./internal/user/ -run TestResolveMiddleware -v`
Expected: FAIL (`ResolveMiddleware`, `IDFromContext` undefined).

- [ ] **Step 7: Implement middleware** — `api/internal/user/middleware.go`

```go
package user

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
)

const contextUserID = "user_id"

// ResolveMiddleware provisions-and-resolves the authenticated user once per
// request, so every downstream handler can read a guaranteed users.id without
// each re-querying (and without a brand-new user 500ing on non-/me endpoints).
func ResolveMiddleware(repo Repository) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetString("uid")
		if uid == "" {
			httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
			return
		}
		u, err := repo.EnsureUser(c.Request.Context(), uid, c.GetString("email"))
		if err != nil {
			httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not resolve user")
			return
		}
		c.Set(contextUserID, u.ID)
		c.Next()
	}
}

func IDFromContext(c *gin.Context) (uuid.UUID, bool) {
	v, ok := c.Get(contextUserID)
	if !ok {
		return uuid.Nil, false
	}
	id, ok := v.(uuid.UUID)
	return id, ok
}
```

- [ ] **Step 8: Run — verify pass**

Run: `cd api && go test ./internal/user/ -run TestResolveMiddleware -v`
Expected: PASS.

- [ ] **Step 9: Mount middleware + simplify handlers** — in `api/internal/server/router.go`, add `v1.Use(user.ResolveMiddleware(userRepo))` immediately after the `v1 := r.Group("/v1", auth.Middleware(deps.Verifier))` line (before any route registration).

Then in `foodlog/handler.go`, `tracking/handler.go`, `dashboard/handler.go`: replace each private `resolveUser(c)` body with a call to `user.IDFromContext(c)`:

```go
func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}
```

In `onboarding/handler.go` `Submit`, replace the `IDByFirebaseUID` block with:

```go
	userID, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
```

(Keep the existing `uid`-based nothing else; the handlers still need `user` imported. `dashboard/handler.go` currently resolves inline — swap to `user.IDFromContext` the same way.) Some handlers no longer use `h.users` — leave the field if other methods use it; if a handler's `users` field becomes entirely unused, remove it and update its `NewHandler` + the router construction accordingly.

- [ ] **Step 10: Full suite + boot check**

Run: `cd api && gofmt -l . && go vet ./... && go test -p 1 ./...`
Expected: all clean/pass.

- [ ] **Step 11: Commit**

```bash
git add api/internal
git commit -m "feat: resolve-user middleware provisions users and dries handlers"
```

---

### Task 2: Typed validation errors — stop infra errors returning 400/leaking

**Files:**
- Create: `api/internal/httpx/errors.go`, `api/internal/httpx/errors_test.go`
- Modify: `api/internal/foodlog/service.go` (validation → `httpx.ValidationError`), `api/internal/foodlog/handler.go` (use `httpx.RespondServiceError`), `api/internal/tracking/repository.go` + `api/internal/tracking/handler.go`

**Interfaces:**
- Produces:
  - `httpx.ValidationError` — `type ValidationError struct{ Message string }` implementing `error` (`Error() string { return Message }`).
  - `httpx.IsValidation(err error) (string, bool)` — unwraps to a `ValidationError`, returns its message.
  - `httpx.RespondServiceError(c *gin.Context, err error)` — if validation → `400 invalid_input` with the validation message; else → `500 internal_error` with generic `"something went wrong"`.

- [ ] **Step 1: Write failing errors test** — `api/internal/httpx/errors_test.go`

```go
package httpx

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestRespondServiceErrorValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	RespondServiceError(c, ValidationError{Message: "quantity must be positive"})
	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.JSONEq(t, `{"error":"invalid_input","message":"quantity must be positive"}`, w.Body.String())
}

func TestRespondServiceErrorInfraIsGenericAnd500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	RespondServiceError(c, fmt.Errorf("foodlog: db exploded: %w", fmt.Errorf("pq: connection refused")))
	assert.Equal(t, http.StatusInternalServerError, w.Code)
	// Must NOT leak the internal message.
	assert.JSONEq(t, `{"error":"internal_error","message":"something went wrong"}`, w.Body.String())
}

func TestValidationErrorWrapsAndUnwraps(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", ValidationError{Message: "bad slot"})
	msg, ok := IsValidation(wrapped)
	assert.True(t, ok)
	assert.Equal(t, "bad slot", msg)
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/httpx/ -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — `api/internal/httpx/errors.go`

```go
package httpx

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ValidationError is a client-safe, 400-worthy error. Its message is intended
// for display. Any error that is NOT a ValidationError is treated as infra and
// returned as a generic 500 (its detail is never sent to the client).
type ValidationError struct {
	Message string
}

func (e ValidationError) Error() string { return e.Message }

func IsValidation(err error) (string, bool) {
	var ve ValidationError
	if errors.As(err, &ve) {
		return ve.Message, true
	}
	return "", false
}

func RespondServiceError(c *gin.Context, err error) {
	if msg, ok := IsValidation(err); ok {
		Error(c, http.StatusBadRequest, "invalid_input", msg)
		return
	}
	Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd api && go test ./internal/httpx/ -v`
Expected: PASS.

- [ ] **Step 5: Make foodlog validation typed** — in `api/internal/foodlog/service.go` `LogFood`, replace the three validation returns:

```go
	if !validMealSlots[req.MealSlot] {
		return FoodLog{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	if req.QuantityGrams <= 0 {
		return FoodLog{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
	}
	if req.FoodItemID == nil {
		return FoodLog{}, httpx.ValidationError{Message: "food_item_id is required"}
	}
```

Leave the `s.foods.GetByID` error as a plain wrapped `fmt.Errorf("foodlog: resolve food: %w", err)` (infra). Import `github.com/tesserix/kora/api/internal/httpx`.

Note: a not-found food id is arguably a client error, but resolving it via GORM returns `ErrRecordNotFound` mixed with infra failures; keep it as infra (500) for now — a dedicated `food not found` 404 is a later refinement.

- [ ] **Step 6: Handlers use RespondServiceError** — in `api/internal/foodlog/handler.go`, the `Create` handler currently does `httpx.Error(c, http.StatusBadRequest, "invalid_input", err.Error())` on `LogFood` error. Replace with `httpx.RespondServiceError(c, err)`. Do the same anywhere a `foodlog` service error is surfaced.

- [ ] **Step 7: Tracking validation typed** — in `api/internal/tracking/repository.go` `AddWater`, replace `return WaterEntry{}, fmt.Errorf("tracking: volume_ml must be positive")` with `return WaterEntry{}, httpx.ValidationError{Message: "volume_ml must be positive"}` (import `httpx`). Keep the `Create` error as infra. In `api/internal/tracking/handler.go` `Add`, replace the `400 invalid_input err.Error()` with `httpx.RespondServiceError(c, err)`.

- [ ] **Step 8: Full suite + commit**

Run: `cd api && gofmt -l . && go vet ./... && go test -p 1 ./...`
Expected: all pass (existing foodlog/tracking tests still green — validation still returns 400, now via the typed path).

```bash
git add api/internal
git commit -m "feat: typed validation errors so infra failures return 500 without leaking"
```

---

### Task 3: User timezone → day-boundary bucketing

**Files:**
- Create: `api/internal/database/migrations/000003_user_timezone.up.sql`, `.down.sql`
- Modify: `api/internal/user/model.go` (add `Timezone`), `api/internal/user/middleware.go` (set `user_loc`), `api/internal/onboarding/calc.go` + `handler.go` (accept/store timezone), `api/internal/user/repository.go` (`SaveOnboarding` persists timezone)
- Modify: `api/internal/foodlog/handler.go`, `api/internal/tracking/handler.go`, `api/internal/dashboard/handler.go` (use `user_loc` from context instead of `time.UTC`)

**Interfaces:**
- Produces:
  - `users.timezone TEXT NOT NULL DEFAULT 'Australia/Sydney'`; `user.User.Timezone string`.
  - `user.LocFromContext(c) *time.Location` — parses the resolved user's timezone (set by the middleware); falls back to `time.UTC` on parse failure.
  - `onboarding.Input` gains `Timezone string` (optional; default `Australia/Sydney` when empty).

- [ ] **Step 1: Migration** — `api/internal/database/migrations/000003_user_timezone.up.sql`

```sql
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Australia/Sydney';
```

`.down.sql`:

```sql
ALTER TABLE users DROP COLUMN timezone;
```

- [ ] **Step 2: Add field** — `api/internal/user/model.go`, add to `User`:

```go
	Timezone string `json:"timezone"`
```

(place it near the other profile columns; GORM maps to `timezone`).

- [ ] **Step 3: Middleware sets location** — in `api/internal/user/middleware.go`, add `const contextUserLoc = "user_loc"`, and after `c.Set(contextUserID, u.ID)`:

```go
		loc, err := time.LoadLocation(u.Timezone)
		if err != nil {
			loc = time.UTC
		}
		c.Set(contextUserLoc, loc)
```

Add `LocFromContext`:

```go
func LocFromContext(c *gin.Context) *time.Location {
	v, ok := c.Get(contextUserLoc)
	if !ok {
		return time.UTC
	}
	loc, ok := v.(*time.Location)
	if !ok {
		return time.UTC
	}
	return loc
}
```

Add `"time"` to imports.

- [ ] **Step 4: Onboarding accepts timezone** — in `api/internal/onboarding/calc.go`, add to `Input`:

```go
	Timezone string `json:"timezone"`
```

In `api/internal/onboarding/handler.go` `Submit`, after computing targets, default the timezone and pass it to `SaveOnboarding`. Add to the `user.OnboardingFields` a `Timezone string`, and set:

```go
	tz := in.Timezone
	if tz == "" {
		tz = "Australia/Sydney"
	}
```

Include `Timezone: tz` in the `OnboardingFields` literal.

- [ ] **Step 5: Persist timezone** — in `api/internal/user/repository.go`, add `Timezone string` to `OnboardingFields` and add `"timezone": f.Timezone,` to the `SaveOnboarding` updates map.

- [ ] **Step 6: Handlers use user_loc** — in `foodlog/handler.go` `List` and `CopyDay`, `tracking/handler.go` `Add`/`DayTotal`, `dashboard/handler.go` `Get`: replace `time.UTC` passed to `ListByUserAndDay`/`WaterTotalForDay`/`ForDay` with `user.LocFromContext(c)`. (Import `user` where not already imported.)

- [ ] **Step 7: Migrate + full suite**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable go run ./cmd/migrate && gofmt -l . && go vet ./... && go test -p 1 ./...`
Expected: migration applies; all pass.

- [ ] **Step 8: Verify down migration reverses** (manual)

Run: `migrate -path internal/database/migrations -database 'postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' down 1` then `up`.
Expected: no error both directions. (If `migrate` CLI is unavailable, skip — the up path is exercised by the suite.)

- [ ] **Step 9: Commit**

```bash
git add api/internal
git commit -m "feat: per-user timezone drives day-boundary bucketing"
```

---

### Task 4: O(1) streak query

**Files:**
- Modify: `api/internal/foodlog/repository.go` (add `LoggedDaysDesc`), `api/internal/dashboard/service.go` (`streakDays` uses it), `api/internal/foodlog/repository_days_test.go` (new)

**Interfaces:**
- Produces:
  - `foodlog.Repository.LoggedDaysDesc(ctx, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error)` — distinct `YYYY-MM-DD` (in `loc`) that have ≥1 log with `logged_at < end-of-notAfter-day`, descending, capped at `limit`.

- [ ] **Step 1: Write failing test** — `api/internal/foodlog/repository_days_test.go`

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

func TestLoggedDaysDescReturnsDistinctDays(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Days Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	// Two logs same day + one the day before.
	d := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual", QuantityGrams: 100, LoggedAt: d})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "dinner", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(6 * time.Hour)})
	_, _ = svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: d.Add(-24 * time.Hour)})

	days, err := NewRepository(db).LoggedDaysDesc(context.Background(), userID, d, time.UTC, 400)
	require.NoError(t, err)
	require.Equal(t, []string{"2026-04-10", "2026-04-09"}, days)
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/foodlog/ -run TestLoggedDaysDesc -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `api/internal/foodlog/repository.go`

```go
// LoggedDaysDesc returns distinct calendar days (YYYY-MM-DD in loc) that have at
// least one log at or before `notAfter`'s day, most-recent first, capped at limit.
func (r Repository) LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error) {
	if limit <= 0 || limit > 4000 {
		limit = 4000
	}
	end := time.Date(notAfter.Year(), notAfter.Month(), notAfter.Day(), 0, 0, 0, 0, loc).Add(24 * time.Hour)
	tz := loc.String()
	var days []string
	err := r.db.WithContext(ctx).
		Model(&FoodLog{}).
		Where("user_id = ? AND logged_at < ?", userID, end).
		Select("DISTINCT to_char(logged_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day", tz).
		Order("day DESC").
		Limit(limit).
		Pluck("day", &days).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: logged days: %w", err)
	}
	return days, nil
}
```

Note: `Pluck` with a `Select` of a computed alias — if GORM rejects the combination, fall back to `.Scan(&days)` into `[]string` using a struct-free scan, or `Raw(...)`. Verify against Postgres; the intent is one query returning distinct day strings.

- [ ] **Step 4: Run — verify pass**

Run: `cd api && go test ./internal/foodlog/ -run TestLoggedDaysDesc -v`
Expected: PASS (`["2026-04-10","2026-04-09"]`).

- [ ] **Step 5: Rewrite streakDays** — replace `streakDays` in `api/internal/dashboard/service.go` with a set-walk over one query:

```go
func (s Service) streakDays(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (int, error) {
	days, err := s.logs.LoggedDaysDesc(ctx, userID, day, loc, 4000)
	if err != nil {
		return 0, err
	}
	have := make(map[string]bool, len(days))
	for _, d := range days {
		have[d] = true
	}
	streak := 0
	cursor := day
	for {
		key := cursor.In(loc).Format("2006-01-02")
		if !have[key] {
			break
		}
		streak++
		cursor = cursor.Add(-24 * time.Hour)
	}
	return streak, nil
}
```

- [ ] **Step 6: Full suite + commit**

Run: `cd api && gofmt -l . && go vet ./... && go test -p 1 ./...`
Expected: dashboard streak test still passes (streak=1 for the single-day case).

```bash
git add api/internal
git commit -m "perf: compute dashboard streak with a single distinct-days query"
```

---

### Task 5: Onboarding formula constants + carb-floor test

**Files:**
- Modify: `api/internal/onboarding/calc.go`, `api/internal/onboarding/calc_test.go`

**Interfaces:** unchanged public API (`Calculate` signature stable). Internal named constants replace inline literals.

- [ ] **Step 1: Add named constants** — in `api/internal/onboarding/calc.go`, above `Calculate`:

```go
const (
	bmrWeightCoef   = 10.0
	bmrHeightCoef   = 6.25
	bmrAgeCoef      = 5.0
	bmrMaleOffset   = 5.0
	bmrFemaleOffset = -161.0
	maxAgeYears     = 120
	proteinGPerKg   = 2.0
	fatCaloriePct   = 0.25
	kcalPerGramFat  = 9.0
	kcalPerGramMacro = 4.0 // protein and carbs
)
```

Rewrite the math to use them:

```go
	bmr := bmrWeightCoef*in.WeightKg + bmrHeightCoef*in.HeightCm - bmrAgeCoef*float64(age)
	if in.Sex == "male" {
		bmr += bmrMaleOffset
	} else {
		bmr += bmrFemaleOffset
	}
	kcal := bmr*factor + adjust

	proteinG := proteinGPerKg * in.WeightKg
	fatG := (kcal * fatCaloriePct) / kcalPerGramFat
	carbsG := (kcal - proteinG*kcalPerGramMacro - fatG*kcalPerGramFat) / kcalPerGramMacro
	if carbsG < 0 {
		carbsG = 0
	}
```

Update the age check to `if age <= 0 || age > maxAgeYears {`.

- [ ] **Step 2: Add carb-floor test** — append to `api/internal/onboarding/calc_test.go`

```go
func TestCalculateClampsCarbsToZero(t *testing.T) {
	// Very low kcal + high bodyweight drives protein+fat calories above total,
	// so carbs would go negative and must clamp to 0.
	got, err := Calculate(Input{Sex: "female", BirthYear: 1960, HeightCm: 150, WeightKg: 150, ActivityLevel: "sedentary", Goal: "fat_loss"}, 2025)
	require.NoError(t, err)
	require.GreaterOrEqual(t, got.CarbsG, 0.0)
	require.Equal(t, 0.0, got.CarbsG)
}
```

Note: if the chosen inputs don't actually drive carbs negative, adjust weight upward (e.g. 200) until `proteinG*4 + fatG*9 > kcal`. The test must exercise the clamp — verify by computing: protein=2*150=300g→1200kcal, plus fat; against a fat_loss kcal near ~1000, carbs go negative. Confirm empirically and tune the literal so the branch is genuinely hit.

- [ ] **Step 3: Run — verify pass**

Run: `cd api && go test ./internal/onboarding/ -v`
Expected: all pass including the new clamp test (2759 / 1418 values unchanged — constants are the same numbers).

- [ ] **Step 4: Commit**

```bash
git add api/internal/onboarding
git commit -m "refactor: name onboarding formula constants and test carb floor"
```

---

### Task 6: foodlog Repeat — optional body

**Files:**
- Modify: `api/internal/foodlog/handler.go` (`Repeat`), `api/internal/foodlog/handler_test.go` (add empty-body case)

**Interfaces:** `POST /v1/logs/:id/repeat` now accepts an empty body (defaults `at` to now).

- [ ] **Step 1: Write failing test** — append to `api/internal/foodlog/handler_test.go` a case that POSTs `/v1/logs/:id/repeat` with **no body** and expects 201. (Reuse the seeded user + food + a first log from the existing test's setup pattern; register the `Repeat` route with the uid-setting middleware and `POST("/v1/logs/:id/repeat", h.Repeat)`.)

```go
func TestRepeatWithEmptyBodyDefaultsToNow(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	fuid := "repeat-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "r@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	item := nutrition.FoodItem{Name: "Repeat Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))
	first, err := svc.LogFood(context.Background(), u.ID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now()})
	require.NoError(t, err)

	h := NewHandler(svc, repo, uRepo)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Set("user_id", u.ID); c.Next() })
	r.POST("/v1/logs/:id/repeat", h.Repeat)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/logs/"+first.ID.String()+"/repeat", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}
```

(Note the middleware sets both `uid` and `user_id` since Task 1 made handlers read `user_id` from context.)

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/foodlog/ -run TestRepeatWithEmptyBody -v`
Expected: FAIL (400 from `ShouldBindJSON` on empty body).

- [ ] **Step 3: Fix Repeat** — in `api/internal/foodlog/handler.go` `Repeat`, replace the bind block:

```go
	var req repeatRequest
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	at := req.At
	if at.IsZero() {
		at = time.Now()
	}
```

Add `"errors"` and `"io"` to imports.

- [ ] **Step 4: Run — verify pass, then full suite**

Run: `cd api && go test ./internal/foodlog/ -v && go test -p 1 ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog
git commit -m "fix: foodlog repeat accepts empty body and defaults to now"
```

---

### Task 7: nutrition.Insert dedups on barcode

**Files:**
- Modify: `api/internal/nutrition/repository.go` (`Insert`), `api/internal/nutrition/repository_test.go` (add barcode-dedup test)

**Interfaces:** `Insert` unchanged signature; now also skips an item whose barcode already exists.

- [ ] **Step 1: Write failing test** — append to `api/internal/nutrition/repository_test.go`

```go
func TestInsertDedupsOnBarcode(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	bc := "999" + uuid.NewString()[:9]
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE barcode = ?", bc) })

	first := []FoodItem{{Name: "Barcode A", Provenance: ProvenanceOFF, Barcode: &bc, KcalPer100g: 100}}
	n1, err := repo.Insert(context.Background(), first)
	require.NoError(t, err)
	require.Equal(t, 1, n1)

	// Different name, SAME barcode → must be skipped (would violate the unique index).
	second := []FoodItem{{Name: "Barcode A Renamed", Provenance: ProvenanceOFF, Barcode: &bc, KcalPer100g: 100}}
	n2, err := repo.Insert(context.Background(), second)
	require.NoError(t, err)
	require.Equal(t, 0, n2)
}
```

Add `"github.com/google/uuid"` import if missing.

- [ ] **Step 2: Run — verify fail**

Run: `cd api && go test ./internal/nutrition/ -run TestInsertDedupsOnBarcode -v`
Expected: FAIL (second insert either inserts or errors on the unique index).

- [ ] **Step 3: Fix Insert** — in `api/internal/nutrition/repository.go` `Insert`, before the name+brand check, add a barcode check:

```go
	for _, item := range items {
		if item.Barcode != nil && *item.Barcode != "" {
			var bcount int64
			if err := r.db.WithContext(ctx).Model(&FoodItem{}).
				Where("barcode = ?", *item.Barcode).
				Count(&bcount).Error; err != nil {
				return inserted, fmt.Errorf("nutrition: insert barcode check: %w", err)
			}
			if bcount > 0 {
				continue
			}
		}
		var count int64
		// ... existing name+brand check + create ...
	}
```

(Integrate into the existing loop — keep the name+brand check as the fallback for barcodeless items.)

- [ ] **Step 4: Run — verify pass, then full suite**

Run: `cd api && go test ./internal/nutrition/ -v && go test -p 1 ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition
git commit -m "fix: nutrition insert dedups on barcode to avoid unique-index conflicts"
```

---

### Task 8: Mobile — onboarding validation + accessibility labels

**Files:**
- Modify: `apps/mobile/app/onboarding.tsx`, `apps/mobile/app/log.tsx`
- Create: `apps/mobile/src/lib/validateOnboarding.ts`, `apps/mobile/src/lib/__tests__/validateOnboarding.test.ts`

**Interfaces:**
- Produces: `validateOnboardingNumbers(birthYear, heightCm, weightKg: string): string | null` — returns an error message if any is empty/NaN/non-positive/out-of-range, else null.

- [ ] **Step 1: Write failing validation test** — `apps/mobile/src/lib/__tests__/validateOnboarding.test.ts`

```ts
import { validateOnboardingNumbers } from "../validateOnboarding";

test("rejects empty fields", () => {
  expect(validateOnboardingNumbers("", "180", "80")).toBeTruthy();
});

test("rejects non-numeric", () => {
  expect(validateOnboardingNumbers("abc", "180", "80")).toBeTruthy();
});

test("rejects out-of-range", () => {
  expect(validateOnboardingNumbers("1995", "0", "80")).toBeTruthy();
  expect(validateOnboardingNumbers("1700", "180", "80")).toBeTruthy();
});

test("accepts valid input", () => {
  expect(validateOnboardingNumbers("1995", "180", "80")).toBeNull();
});
```

- [ ] **Step 2: Run — verify fail**

Run (FOREGROUND): `cd apps/mobile && npm test -- validateOnboarding`
Expected: FAIL.

- [ ] **Step 3: Implement** — `apps/mobile/src/lib/validateOnboarding.ts`

```ts
export function validateOnboardingNumbers(
  birthYear: string,
  heightCm: string,
  weightKg: string,
): string | null {
  const by = Number(birthYear);
  const h = Number(heightCm);
  const w = Number(weightKg);

  if (!birthYear || !heightCm || !weightKg) {
    return "Please fill in your birth year, height, and weight.";
  }
  if (Number.isNaN(by) || Number.isNaN(h) || Number.isNaN(w)) {
    return "Birth year, height, and weight must be numbers.";
  }
  if (by < 1900 || by > 2020) {
    return "Please enter a valid birth year.";
  }
  if (h <= 0 || h > 260) {
    return "Please enter a valid height in cm.";
  }
  if (w <= 0 || w > 500) {
    return "Please enter a valid weight in kg.";
  }
  return null;
}
```

- [ ] **Step 4: Run — verify pass**

Run (FOREGROUND): `cd apps/mobile && npm test -- validateOnboarding`
Expected: PASS.

- [ ] **Step 5: Wire into onboarding.tsx** — in `apps/mobile/app/onboarding.tsx` `onSubmit`, before building `input`, add:

```tsx
    const validationError = validateOnboardingNumbers(birthYear, heightCm, weightKg);
    if (validationError) {
      setError(validationError);
      return;
    }
```

Import `validateOnboardingNumbers` from `@/lib/validateOnboarding`. Add `accessibilityLabel` to each numeric `TextInput` (`accessibilityLabel="Birth year"`, `"Height in centimetres"`, `"Weight in kilograms"`).

- [ ] **Step 6: a11y labels on log.tsx** — in `apps/mobile/app/log.tsx`, add `accessibilityLabel="Search foods"` to the search `TextInput` and `accessibilityLabel="Quantity in grams"` to the grams `TextInput`.

- [ ] **Step 7: Typecheck + full test + commit**

Run (FOREGROUND): `cd apps/mobile && npx tsc --noEmit && npm test`
Expected: tsc clean; all pass.

```bash
git add apps/mobile
git commit -m "feat: onboarding client-side validation and accessibility labels"
```

---

## Definition of Done (Phase 1b)

- [ ] A brand-new user hitting `/v1/dashboard` or `/v1/logs` before `/v1/me` no longer 500s (the resolve middleware provisions the row).
- [ ] `resolveUser` boilerplate exists in exactly one place (`user.ResolveMiddleware` + `IDFromContext`).
- [ ] A forced infra error in a service returns `500 internal_error` with a generic message (no leaked detail); genuine validation still returns `400 invalid_input` with a helpful message.
- [ ] `users.timezone` exists (default `Australia/Sydney`), is set at onboarding, and drives day bucketing in dashboard/logs/water.
- [ ] Dashboard streak is computed with a single distinct-days query.
- [ ] Onboarding formula uses named constants; the carb-floor branch has a test.
- [ ] `POST /v1/logs/:id/repeat` works with an empty body.
- [ ] `nutrition.Insert` skips items whose barcode already exists.
- [ ] Onboarding rejects empty/NaN/out-of-range numbers client-side; onboarding + log inputs have accessibility labels.
- [ ] Go suite passes with `go test -race -p 1 ./...`; mobile `tsc --noEmit` + `npm test` pass.
