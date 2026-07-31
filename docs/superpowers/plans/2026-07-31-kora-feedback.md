# Kora In-App Feedback — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a beta user file a bug or feature request from inside Kora, stored in a shape that maps mechanically onto the platform `tickets-service` later.

**Architecture:** One table, one `POST /v1/feedback` endpoint. Columns mirror the `tickets-service` `Ticket` contract so the eventual tesserix-home integration is a projection, not a redesign. Capture-only: no comments, attachments, assignees, or status transitions.

**Tech Stack:** Go 1.26, Gin, GORM, golang-migrate, testify/require. Tests run against Postgres via `TEST_DATABASE_URL`.

Spec: `docs/superpowers/specs/2026-07-31-kora-feedback-design.md`

## Global Constraints

- **The reporter comes from the auth context, never the request body.** A `user_id` in the body must be ignored, not honoured.
- Migration number is **`000019`**. `000018` is `coach_turns` on the in-flight thread-persistence branch. **Before writing it, grep the migrations directory to confirm `000019` is unused and that nothing already creates a `feedback` table** — a duplicate-table migration is exactly the bug that took CI down for weeks.
- Verify the full chain against a genuinely FRESH database, not an incremental apply.
- Every text field length-capped and the request body bounded, following the cap `POST /v1/coach/ask` now uses (see `maxAskQuestionChars` and the `http.MaxBytesReader` usage in `api/internal/coach/handler.go` and `api/internal/resolve/handler.go`).
- Over-length or malformed input returns the repo's standard 400 `invalid_input` shape — never a panic, never a 500.
- Model idiom: explicit `TableName()`, `gorm:"type:uuid;default:gen_random_uuid();primaryKey"` on IDs, `ix_`-prefixed indexes in SQL.
- Responses use `httpx.OK` (`{"data": ...}`) and snake_case JSON keys.
- Run Go tests in the **foreground**, never backgrounded.
- `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'` (container `kora-pg-test`). Do not recreate, restart, or remove the container.
- Do NOT run `go run ./cmd/seed`.
- Single-line conventional-commit messages, no body, no `Co-Authored-By`, no signature.
- Branch `kora-feedback`, based on the current tip of the coach stack (so `000019` does not collide with `000018`).

---

### Task 1: Migration, model, and repository

**Files:**
- Create: `api/internal/database/migrations/000019_feedback.up.sql`
- Create: `api/internal/database/migrations/000019_feedback.down.sql`
- Create: `api/internal/feedback/model.go`
- Create: `api/internal/feedback/repository.go`
- Test: `api/internal/feedback/repository_test.go`

**Interfaces:**
- Produces:
  - `feedback.Kind` string type: `KindBug Kind = "bug"`, `KindFeature Kind = "feature"`, plus `func (k Kind) Valid() bool`
  - `feedback.Status` string type: `StatusOpen Status = "open"`
  - `feedback.Feedback{ID, UserID uuid.UUID, Kind Kind, Title, Body string, Status Status, AppVersion, Platform, OSVersion, DeviceModel string, CreatedAt time.Time}`, `TableName() == "feedback"`
  - `feedback.Repository` with `NewRepository(db *gorm.DB) Repository` and `Create(ctx context.Context, f Feedback) (Feedback, error)`

- [ ] **Step 1: Confirm the migration slot is free**

```bash
cd api
grep -rn "feedback" internal/database/migrations/ || echo "no existing feedback table"
ls internal/database/migrations/ | grep 000019 || echo "000019 free"
```

Expected: no existing `feedback` table, `000019` free. If either check fails, STOP and report.

- [ ] **Step 2: Write the migration**

`api/internal/database/migrations/000019_feedback.up.sql`:

```sql
-- Kora in-app feedback. Column names mirror the platform tickets-service
-- Ticket contract (kind->type, body->description, user_id->created_by, the
-- client columns->metadata) so a later tesserix-home integration is a
-- projection rather than a redesign. tenant_id/product_id/application_id are
-- deliberately absent: Kora is a single-product app with no tenancy, so those
-- are constants supplied at integration time.
CREATE TABLE feedback (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    app_version  TEXT NOT NULL DEFAULT '',
    platform     TEXT NOT NULL DEFAULT '',
    os_version   TEXT NOT NULL DEFAULT '',
    device_model TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_feedback_user_created ON feedback (user_id, created_at);
CREATE INDEX ix_feedback_status_created ON feedback (status, created_at);
```

The second index serves the eventual admin read ("all open feedback, newest first"), which is the only query the integration will need.

`api/internal/database/migrations/000019_feedback.down.sql`:

```sql
DROP TABLE IF EXISTS feedback;
```

- [ ] **Step 3: Write the model**

`api/internal/feedback/model.go`:

```go
// Package feedback captures in-app bug reports and feature requests from
// Kora users. It is capture-only: no comments, attachments, assignees, or
// status transitions. Field names deliberately mirror the platform
// tickets-service Ticket contract so a later tesserix-home integration is a
// projection rather than a redesign.
package feedback

import (
	"time"

	"github.com/google/uuid"
)

// Kind is what the user is telling us: a defect or a request.
// Values map to tickets-service TicketType BUG / FEATURE.
type Kind string

const (
	KindBug     Kind = "bug"
	KindFeature Kind = "feature"
)

// Valid reports whether k is a recognised kind. Anything else is rejected at
// the handler rather than stored, so the column never accumulates values the
// tickets-service mapping cannot express.
func (k Kind) Valid() bool {
	return k == KindBug || k == KindFeature
}

// Status mirrors tickets-service TicketStatus. Kora only ever writes Open —
// triage happens in admin once the integration exists.
type Status string

const StatusOpen Status = "open"

// Feedback is one submission.
type Feedback struct {
	ID     uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID uuid.UUID `gorm:"type:uuid;not null;index"`
	Kind   Kind      `gorm:"not null"`
	Title  string    `gorm:"not null"`
	Body   string    `gorm:"not null"`
	Status Status    `gorm:"not null;default:open"`
	// Client context, sent by the app. It is display-only — never trusted for
	// authorisation — and makes a bug report actionable ("crashed on iOS 26.1,
	// app 1.0.0" rather than "it crashed").
	AppVersion  string `gorm:"not null;default:''"`
	Platform    string `gorm:"not null;default:''"`
	OSVersion   string `gorm:"not null;default:''"`
	DeviceModel string `gorm:"not null;default:''"`
	CreatedAt   time.Time
}

func (Feedback) TableName() string { return "feedback" }
```

- [ ] **Step 4: Write the failing repository test**

`api/internal/feedback/repository_test.go`. This package has no test helpers yet — look at how `api/internal/coach/` obtains a test DB and seeds a user (`testDB`, `seedUser`) and follow the same approach, creating the equivalent local helpers here. Skip when Postgres is absent, as the other packages do.

```go
func TestRepository_CreateRoundTrip(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	saved, err := repo.Create(context.Background(), Feedback{
		UserID:      userID,
		Kind:        KindBug,
		Title:       "Camera freezes on capture",
		Body:        "Tapping the shutter freezes the app for ~5s.",
		Status:      StatusOpen,
		AppVersion:  "1.0.0",
		Platform:    "ios",
		OSVersion:   "26.1",
		DeviceModel: "iPhone17,2",
	})
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, saved.ID, "the database must assign an id")
	require.False(t, saved.CreatedAt.IsZero(), "created_at must be populated")

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", saved.ID).Error)
	require.Equal(t, userID, got.UserID)
	require.Equal(t, KindBug, got.Kind)
	require.Equal(t, "Camera freezes on capture", got.Title)
	require.Equal(t, StatusOpen, got.Status)
	require.Equal(t, "ios", got.Platform)
	require.Equal(t, "iPhone17,2", got.DeviceModel)
}

func TestRepository_CreateDefaultsStatusToOpen(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	saved, err := repo.Create(context.Background(), Feedback{
		UserID: userID, Kind: KindFeature, Title: "Dark mode", Body: "Please.",
	})
	require.NoError(t, err)

	var got Feedback
	require.NoError(t, db.First(&got, "id = ?", saved.ID).Error)
	require.Equal(t, StatusOpen, got.Status, "the column default must apply when the caller omits status")
}
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/feedback/ -v`

Expected: FAIL — `undefined: NewRepository`.

- [ ] **Step 6: Implement the repository**

`api/internal/feedback/repository.go`:

```go
package feedback

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

// Repository persists feedback submissions.
type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Create stores one submission and returns it with its database-assigned id
// and timestamp.
func (r Repository) Create(ctx context.Context, f Feedback) (Feedback, error) {
	if err := r.db.WithContext(ctx).Create(&f).Error; err != nil {
		return Feedback{}, fmt.Errorf("feedback: create: %w", err)
	}
	return f, nil
}
```

Note: `Status` has a column default, but GORM sends the zero value `""` for a string field on insert, which would defeat it. Make sure the default actually applies — either default it in `Create` when empty, or tag the field so GORM omits it. Prove whichever you choose with `TestRepository_CreateDefaultsStatusToOpen`; do not adjust that test to match a broken default.

- [ ] **Step 7: Run to verify it passes**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/feedback/ -v`

Expected: PASS.

- [ ] **Step 8: Verify the migration chain on a FRESH database**

```bash
docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS fb_migtest WITH (FORCE);' -c 'CREATE DATABASE fb_migtest OWNER kora;'
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/fb_migtest?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-test psql -U kora -d fb_migtest -tAc "SELECT version, dirty FROM schema_migrations;"
docker exec kora-pg-test psql -U kora -d fb_migtest -c "\d feedback"
docker exec kora-pg-test psql -U kora -d postgres -c 'DROP DATABASE IF EXISTS fb_migtest WITH (FORCE);'
```

Expected: version `19`, dirty `f`, table present with all eleven columns and both indexes.

Then apply to the main test database: `cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go run ./cmd/migrate`

- [ ] **Step 9: Commit**

```bash
git add api/internal/database/migrations/000019_feedback.up.sql api/internal/database/migrations/000019_feedback.down.sql api/internal/feedback/
git commit -m "feat(feedback): add feedback table, model, and repository"
```

---

### Task 2: HTTP endpoint

**Files:**
- Create: `api/internal/feedback/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/feedback/handler_test.go`

**Interfaces:**
- Consumes: `feedback.Repository` (Task 1); `user.IDFromContext`; `httpx.OK` / `httpx.Error`.
- Produces: `feedback.NewHandler(repo Repository) Handler` with `Create(c *gin.Context)`, wired at `POST /v1/feedback`.
- Request: `{"kind":"bug"|"feature","title":string,"body":string,"app_version":string,"platform":string,"os_version":string,"device_model":string}`
- Response: `httpx.OK` with `{"id": "...", "status": "open"}`.

- [ ] **Step 1: Write the failing tests**

Follow `api/internal/coach/handler_test.go` for the fake-auth router idiom (setting `user_id` on the Gin context directly). Cover:

```
TestHandlerCreate_StoresFeedbackAndReturnsID
TestHandlerCreate_RejectsUnknownKind            // "spam" -> 400 invalid_input
TestHandlerCreate_RejectsEmptyTitle             // "" and "   " -> 400
TestHandlerCreate_RejectsEmptyBody              // "" and "   " -> 400
TestHandlerCreate_RejectsOverlongTitle          // > cap -> 400, not 500, not truncated
TestHandlerCreate_RejectsOverlongBody           // > cap -> 400
TestHandlerCreate_IgnoresUserIDInBody           // body user_id must NOT become the reporter
TestHandlerCreate_Unauthenticated               // no user in context -> 401
```

`TestHandlerCreate_IgnoresUserIDInBody` is the important one: post a body containing a different `user_id`, then assert the stored row's `user_id` is the authenticated user. Write it so it would fail if the handler ever read the reporter from the body.

Assert the raw response body uses snake_case, as the coach handler tests do.

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/feedback/ -run TestHandlerCreate -v`

Expected: FAIL — `undefined: NewHandler`.

- [ ] **Step 3: Implement the handler**

Define caps as named constants with a brief comment (a title is a one-liner; a body should allow a few paragraphs). Trim whitespace before validating so `"   "` is empty. Validate `kind` via `Kind.Valid()`. Take the reporter from `user.IDFromContext` only.

Apply a body-size limit the way `api/internal/coach/handler.go` does.

- [ ] **Step 4: Run to verify they pass**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/feedback/ -v`

Expected: PASS.

- [ ] **Step 5: Wire the route**

In `api/internal/server/router.go`, alongside the other `v1` routes:

```go
		feedbackHandler := feedback.NewHandler(feedback.NewRepository(deps.DB))
		v1.POST("/feedback", feedbackHandler.Create)
```

Place it with the other authenticated `v1` routes so it inherits the same auth middleware. Confirm by reading the surrounding code that it does.

- [ ] **Step 6: Run vet and the full suite exactly as CI does**

```bash
cd api
go vet ./...
TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...
```

Expected: `go vet` clean; every package `ok`, zero `FAIL`. Foreground.

- [ ] **Step 7: Commit**

```bash
git add api/internal/feedback/handler.go api/internal/feedback/handler_test.go api/internal/server/router.go
git commit -m "feat(feedback): add POST /v1/feedback"
```

---

## Done criteria

- `go vet ./...` clean; `go test -race -p 1 -count=1 ./...` fully green.
- Fresh-database migration chain reaches version 19, not dirty.
- `POST /v1/feedback` stores a bug or feature request for the authenticated user and returns its id.
- The reporter always comes from the auth context; a `user_id` in the body is ignored, proven by test.
- Unknown `kind`, empty/whitespace title or body, and over-length input all return 400 `invalid_input`.
- Unauthenticated requests return 401.
- Column names still map cleanly onto the `tickets-service` `Ticket` contract per the spec's table.
