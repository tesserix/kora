# Notification Feed (Social E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-app notification feed — four action-triggered events (friend request received, friend request accepted, added to a group, new challenge in your group) each write a `notifications` row in the same request that causes them; a mobile inbox screen shows them with an unread badge.

**Architecture:** New `internal/notifications` Go package (migration/model/repo/service/handler) mirroring `internal/groups`. A best-effort, nil-safe notifier is attached to the existing `social`/`groups`/`challenges` services via a `WithNotifier` setter (unwired = no-op; a notify failure is logged and never fails the action). Mobile adds types + hooks, a `notifications` inbox screen, a More-tab row, and an unread badge dot on the More tab icon. No push, no scheduler, no device tokens (all E2).

**Tech Stack:** Go 1.26 + Gin + GORM + Postgres (backend); Expo SDK 57 / React Native + React Query + expo-router (mobile).

## Global Constraints

- **Best-effort, never fail the action:** a notifier error is logged with `slog.WarnContext` and the underlying friend-request/accept/invite/challenge-create still succeeds. An unwired (nil) notifier is a no-op — every existing `social`/`groups`/`challenges` test must stay green unchanged.
- **User-scoped:** list/unread/mark-all filter `user_id = caller`; the only other-user data exposed is `actor_id` + `actor_name` (display name only, joined at read time — never email).
- **The reverse-pending auto-accept edge fires `friend_accept`** (not `friend_request`) to the original requester; idempotent re-sends fire nothing.
- **GORM zero-time gotcha:** `Notification.CreatedAt` is a bare `time.Time` relying on SQL `DEFAULT now()` → tag it `gorm:"autoCreateTime"`.
- **Event types (exact strings):** `friend_request｜friend_accept｜group_invite｜challenge_created`. `entity_id` is the deep-link target: group id for `group_invite`, challenge id for `challenge_created`, null for the friend events.
- **Conventional single-line commits, no signature.** Backend DB tests: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`; apply new migrations to `kora_test` first with `go run ./cmd/migrate`. Tests run **FOREGROUND**. Stale RED Go LSP diagnostics after a test-before-impl step are always stale — verify with `go build ./...` / `go test`.
- **Mobile:** `npx tsc --noEmit` + `npm test -- --ci`; no `console.log`; no `any`; `Button` variants `primary|secondary|ghost`; dynamic routes `router.push(path as Href)`; jest.mock factories reference only `mock`-prefixed vars; components that call `useUnreadCount`/`useNotifications` must have those hooks mocked in their tests (no QueryClientProvider in unit tests).

---

### Task 1: Migration `000013` + `notifications` model + repository

**Files:**
- Create: `api/internal/database/migrations/000013_notifications.up.sql`
- Create: `api/internal/database/migrations/000013_notifications.down.sql`
- Create: `api/internal/notifications/model.go`
- Create: `api/internal/notifications/errors.go`
- Create: `api/internal/notifications/repository.go`
- Test: `api/internal/notifications/repository_test.go`

**Interfaces:**
- Consumes: `users(id)` table; `uuid.UUID`; GORM.
- Produces (later tasks rely on these):
  - `notifications.Notification{ID, UserID, ActorID uuid.UUID; Type string; EntityID *uuid.UUID; ReadAt *time.Time; CreatedAt time.Time}`.
  - Type consts `TypeFriendRequest = "friend_request"`, `TypeFriendAccept = "friend_accept"`, `TypeGroupInvite = "group_invite"`, `TypeChallengeCreated = "challenge_created"`.
  - `notifications.NotificationView{ID uuid.UUID; Type string; ActorID uuid.UUID; ActorName string; EntityID *uuid.UUID; Read bool; CreatedAt time.Time}`.
  - `notifications.Repository` with `NewRepository(db) Repository` and `Create(ctx, n Notification) error`, `ListForUser(ctx, userID uuid.UUID, limit int) ([]NotificationView, error)`, `UnreadCount(ctx, userID uuid.UUID) (int, error)`, `MarkAllRead(ctx, userID uuid.UUID) (int, error)`.
  - `Err* ` sentinels (only `ErrBadInput` needed for now — reserve the file).

- [ ] **Step 1: Write the migration up file**

`api/internal/database/migrations/000013_notifications.up.sql`:
```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_id UUID,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX ix_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
```

- [ ] **Step 2: Write the migration down file**

`api/internal/database/migrations/000013_notifications.down.sql`:
```sql
DROP TABLE IF EXISTS notifications;
```

- [ ] **Step 3: Apply the migration to `kora_test`**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`
Expected: migrates to version 13, no error.

- [ ] **Step 4: Write `model.go`**

`api/internal/notifications/model.go`:
```go
// Package notifications owns the in-app notification feed.
package notifications

import (
	"time"

	"github.com/google/uuid"
)

const (
	TypeFriendRequest    = "friend_request"
	TypeFriendAccept     = "friend_accept"
	TypeGroupInvite      = "group_invite"
	TypeChallengeCreated = "challenge_created"
)

type Notification struct {
	ID        uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID  `json:"user_id"`
	Type      string     `json:"type"`
	ActorID   uuid.UUID  `json:"actor_id"`
	EntityID  *uuid.UUID `json:"entity_id,omitempty"`
	ReadAt    *time.Time `json:"read_at,omitempty"`
	CreatedAt time.Time  `gorm:"autoCreateTime" json:"created_at"`
}

// NotificationView is a feed row with the actor's display name joined in.
type NotificationView struct {
	ID        uuid.UUID  `json:"id"`
	Type      string     `json:"type"`
	ActorID   uuid.UUID  `json:"actor_id"`
	ActorName string     `json:"actor_name"`
	EntityID  *uuid.UUID `json:"entity_id,omitempty"`
	Read      bool       `json:"read"`
	CreatedAt time.Time  `json:"created_at"`
}
```

- [ ] **Step 5: Write `errors.go`**

`api/internal/notifications/errors.go`:
```go
package notifications

import "errors"

var ErrBadInput = errors.New("invalid input")
```

- [ ] **Step 6: Write the failing repository test**

`api/internal/notifications/repository_test.go`:
```go
package notifications

import (
	"context"
	"os"
	"testing"

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

func seedUser(t *testing.T, db *gorm.DB, name string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "nt-"+id.String(), "nt-"+id.String()+"@test.dev", name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM notifications WHERE user_id = ? OR actor_id = ?", id, id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestCreateListUnreadMarkAll(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	recipient := seedUser(t, db, "Recipient")
	actor := seedUser(t, db, "Alice")
	gid := uuid.New()

	require.NoError(t, repo.Create(context.Background(), Notification{UserID: recipient, ActorID: actor, Type: TypeFriendRequest}))
	require.NoError(t, repo.Create(context.Background(), Notification{UserID: recipient, ActorID: actor, Type: TypeGroupInvite, EntityID: &gid}))

	// list is newest-first with the actor name joined
	list, err := repo.ListForUser(context.Background(), recipient, 50)
	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, "Alice", list[0].ActorName)
	require.False(t, list[0].Read)

	// unread count = 2, then mark-all clears it
	n, err := repo.UnreadCount(context.Background(), recipient)
	require.NoError(t, err)
	require.Equal(t, 2, n)

	marked, err := repo.MarkAllRead(context.Background(), recipient)
	require.NoError(t, err)
	require.Equal(t, 2, marked)

	n, err = repo.UnreadCount(context.Background(), recipient)
	require.NoError(t, err)
	require.Equal(t, 0, n)
	// second mark-all is a no-op
	marked, err = repo.MarkAllRead(context.Background(), recipient)
	require.NoError(t, err)
	require.Equal(t, 0, marked)
}

func TestListIsUserScoped(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	me := seedUser(t, db, "Me")
	other := seedUser(t, db, "Other")
	actor := seedUser(t, db, "Actor")
	require.NoError(t, repo.Create(context.Background(), Notification{UserID: other, ActorID: actor, Type: TypeFriendRequest}))

	list, err := repo.ListForUser(context.Background(), me, 50)
	require.NoError(t, err)
	require.Len(t, list, 0)
}
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/notifications/`
Expected: FAIL / build error — `NewRepository` and methods undefined.

- [ ] **Step 8: Write `repository.go`**

`api/internal/notifications/repository.go`:
```go
package notifications

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, n Notification) error {
	if err := r.db.WithContext(ctx).Create(&n).Error; err != nil {
		return fmt.Errorf("notifications: create: %w", err)
	}
	return nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID, limit int) ([]NotificationView, error) {
	out := []NotificationView{}
	err := r.db.WithContext(ctx).
		Table("notifications AS n").
		Select("n.id AS id, n.type AS type, n.actor_id AS actor_id, u.display_name AS actor_name, "+
			"n.entity_id AS entity_id, (n.read_at IS NOT NULL) AS read, n.created_at AS created_at").
		Joins("JOIN users u ON u.id = n.actor_id").
		Where("n.user_id = ?", userID).
		Order("n.created_at DESC").
		Limit(limit).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("notifications: list for user: %w", err)
	}
	return out, nil
}

func (r Repository) UnreadCount(ctx context.Context, userID uuid.UUID) (int, error) {
	var c int64
	if err := r.db.WithContext(ctx).Model(&Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Count(&c).Error; err != nil {
		return 0, fmt.Errorf("notifications: unread count: %w", err)
	}
	return int(c), nil
}

func (r Repository) MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error) {
	res := r.db.WithContext(ctx).Model(&Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Update("read_at", gorm.Expr("now()"))
	if res.Error != nil {
		return 0, fmt.Errorf("notifications: mark all read: %w", res.Error)
	}
	return int(res.RowsAffected), nil
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/notifications/`
Expected: PASS (2 tests). `cd api && go build ./...` clean.

- [ ] **Step 10: Commit**

```bash
git add api/internal/database/migrations/000013_notifications.up.sql api/internal/database/migrations/000013_notifications.down.sql api/internal/notifications/
git commit -m "feat(notifications): migration 000013 + model + repository"
```

---

### Task 2: `notifications` service (notifier methods + fan-out + read pass-throughs)

**Files:**
- Create: `api/internal/notifications/service.go`
- Test: `api/internal/notifications/service_test.go`

**Interfaces:**
- Consumes: `notifications.Repository` (via `store` interface), `groups.MemberView` + `groups.Repository` (via `memberLister` interface — imports `internal/groups`, no cycle).
- Produces:
  - `notifications.Service` with `NewService(store store, members memberLister) Service`.
  - Notifier methods: `FriendRequested(ctx, recipientID, actorID uuid.UUID) error`, `FriendAccepted(ctx, recipientID, actorID uuid.UUID) error`, `AddedToGroup(ctx, recipientID, actorID, groupID uuid.UUID) error`, `ChallengeCreated(ctx, groupID, actorID, challengeID uuid.UUID) error`.
  - Read pass-throughs: `List(ctx, userID uuid.UUID) ([]NotificationView, error)`, `UnreadCount(ctx, userID uuid.UUID) (int, error)`, `MarkAllRead(ctx, userID uuid.UUID) (int, error)`.

- [ ] **Step 1: Write the failing service test**

`api/internal/notifications/service_test.go`:
```go
package notifications

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/groups"
)

type stubStore struct{ created []Notification }

func (s *stubStore) Create(_ context.Context, n Notification) error {
	s.created = append(s.created, n)
	return nil
}
func (s *stubStore) ListForUser(_ context.Context, _ uuid.UUID, _ int) ([]NotificationView, error) {
	return nil, nil
}
func (s *stubStore) UnreadCount(_ context.Context, _ uuid.UUID) (int, error) { return 0, nil }
func (s *stubStore) MarkAllRead(_ context.Context, _ uuid.UUID) (int, error) { return 0, nil }

type stubMembers struct{ members []groups.MemberView }

func (s stubMembers) ListMembers(_ context.Context, _ uuid.UUID) ([]groups.MemberView, error) {
	return s.members, nil
}

func TestOneToOneNotifiers(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	recipient, actor, gid := uuid.New(), uuid.New(), uuid.New()

	require.NoError(t, svc.FriendRequested(context.Background(), recipient, actor))
	require.NoError(t, svc.AddedToGroup(context.Background(), recipient, actor, gid))
	require.Len(t, store.created, 2)
	require.Equal(t, TypeFriendRequest, store.created[0].Type)
	require.Equal(t, recipient, store.created[0].UserID)
	require.Nil(t, store.created[0].EntityID)
	require.Equal(t, TypeGroupInvite, store.created[1].Type)
	require.NotNil(t, store.created[1].EntityID)
	require.Equal(t, gid, *store.created[1].EntityID)
}

func TestChallengeCreatedFansOutExcludingActor(t *testing.T) {
	creator, m1, m2, gid, cid := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := &stubStore{}
	svc := NewService(store, stubMembers{members: []groups.MemberView{
		{ID: creator, DisplayName: "Creator", Role: groups.RoleOwner},
		{ID: m1, DisplayName: "M1", Role: groups.RoleMember},
		{ID: m2, DisplayName: "M2", Role: groups.RoleMember},
	}})

	require.NoError(t, svc.ChallengeCreated(context.Background(), gid, creator, cid))
	// two rows — one per member != creator
	require.Len(t, store.created, 2)
	got := map[uuid.UUID]bool{store.created[0].UserID: true, store.created[1].UserID: true}
	require.True(t, got[m1] && got[m2])
	require.False(t, got[creator])
	for _, n := range store.created {
		require.Equal(t, TypeChallengeCreated, n.Type)
		require.NotNil(t, n.EntityID)
		require.Equal(t, cid, *n.EntityID)
		require.Equal(t, creator, n.ActorID)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/notifications/ -run 'TestOneToOne|TestChallengeCreated' -v`
Expected: FAIL / build error — `NewService`, `store`, `memberLister` undefined.

- [ ] **Step 3: Write `service.go`**

`api/internal/notifications/service.go`:
```go
package notifications

import (
	"context"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/groups"
)

const listLimit = 50

// store is the persistence surface the service needs (Repository satisfies it).
type store interface {
	Create(ctx context.Context, n Notification) error
	ListForUser(ctx context.Context, userID uuid.UUID, limit int) ([]NotificationView, error)
	UnreadCount(ctx context.Context, userID uuid.UUID) (int, error)
	MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error)
}

// memberLister lets the challenge fan-out enumerate a group's members
// (groups.Repository satisfies it).
type memberLister interface {
	ListMembers(ctx context.Context, groupID uuid.UUID) ([]groups.MemberView, error)
}

type Service struct {
	store   store
	members memberLister
}

func NewService(s store, members memberLister) Service {
	return Service{store: s, members: members}
}

func (s Service) FriendRequested(ctx context.Context, recipientID, actorID uuid.UUID) error {
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeFriendRequest})
}

func (s Service) FriendAccepted(ctx context.Context, recipientID, actorID uuid.UUID) error {
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeFriendAccept})
}

func (s Service) AddedToGroup(ctx context.Context, recipientID, actorID, groupID uuid.UUID) error {
	gid := groupID
	return s.store.Create(ctx, Notification{UserID: recipientID, ActorID: actorID, Type: TypeGroupInvite, EntityID: &gid})
}

func (s Service) ChallengeCreated(ctx context.Context, groupID, actorID, challengeID uuid.UUID) error {
	members, err := s.members.ListMembers(ctx, groupID)
	if err != nil {
		return err
	}
	cid := challengeID
	var firstErr error
	for _, m := range members {
		if m.ID == actorID {
			continue
		}
		if err := s.store.Create(ctx, Notification{UserID: m.ID, ActorID: actorID, Type: TypeChallengeCreated, EntityID: &cid}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s Service) List(ctx context.Context, userID uuid.UUID) ([]NotificationView, error) {
	return s.store.ListForUser(ctx, userID, listLimit)
}

func (s Service) UnreadCount(ctx context.Context, userID uuid.UUID) (int, error) {
	return s.store.UnreadCount(ctx, userID)
}

func (s Service) MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error) {
	return s.store.MarkAllRead(ctx, userID)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && go test ./internal/notifications/ -run 'TestOneToOne|TestChallengeCreated' -v` then `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/notifications/`
Expected: PASS. `go build ./...` clean.

- [ ] **Step 5: Commit**

```bash
git add api/internal/notifications/service.go api/internal/notifications/service_test.go
git commit -m "feat(notifications): service with notifier methods + challenge fan-out"
```

---

### Task 3: `notifications` handlers + routes

**Files:**
- Create: `api/internal/notifications/handler.go`
- Test: `api/internal/notifications/handler_test.go`
- Modify: `api/internal/server/router.go`

**Interfaces:**
- Consumes: `notifications.Service`, `user.IDFromContext`, `httpx.OK`/`Error`, gin, `groups.NewRepository` (as the memberLister for the wired service).
- Produces: `notifications.Handler` with `NewHandler(svc Service) Handler` and `List`/`UnreadCount`/`MarkAllRead`; `notificationsSvc` constructed early in `router.go` (later reused by Task 4's `WithNotifier` calls); three routes mounted.

- [ ] **Step 1: Write `handler.go`**

`api/internal/notifications/handler.go`:
```go
package notifications

import (
	"net/http"

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

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	items, err := h.svc.List(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load notifications")
		return
	}
	httpx.OK(c, items)
}

func (h Handler) UnreadCount(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	n, err := h.svc.UnreadCount(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load count")
		return
	}
	httpx.OK(c, gin.H{"count": n})
}

func (h Handler) MarkAllRead(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	n, err := h.svc.MarkAllRead(c.Request.Context(), uid)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not mark read")
		return
	}
	httpx.OK(c, gin.H{"marked": n})
}
```

- [ ] **Step 2: Write the failing handler test**

`api/internal/notifications/handler_test.go`:
```go
package notifications

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/groups"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	svc := NewService(NewRepository(db), groups.NewRepository(db))
	h := NewHandler(svc)
	r.GET("/v1/notifications", h.List)
	r.GET("/v1/notifications/unread-count", h.UnreadCount)
	r.POST("/v1/notifications/read", h.MarkAllRead)
	return r
}

func do(r *gin.Engine, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestNotificationEndpoints(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	actor := seedUser(t, db, "Actor")
	require.NoError(t, NewRepository(db).Create(context.Background(), Notification{UserID: me, ActorID: actor, Type: TypeFriendRequest}))

	r := mountFor(me, db)
	require.Equal(t, http.StatusOK, do(r, http.MethodGet, "/v1/notifications").Code)
	require.Equal(t, http.StatusOK, do(r, http.MethodGet, "/v1/notifications/unread-count").Code)
	require.Equal(t, http.StatusOK, do(r, http.MethodPost, "/v1/notifications/read").Code)
}

func TestNotificationsUnauthorized(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New() // no user_id middleware
	svc := NewService(NewRepository(db), groups.NewRepository(db))
	h := NewHandler(svc)
	r.GET("/v1/notifications", h.List)
	require.Equal(t, http.StatusUnauthorized, do(r, http.MethodGet, "/v1/notifications").Code)
}
```

- [ ] **Step 3: Run the handler test (GREEN once handler.go exists)**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/notifications/ -run TestNotification -v`
Expected: PASS (handler.go written in Step 1; this is integration-style, so no strict RED phase).

- [ ] **Step 4: Wire the service + routes in `router.go`**

In `api/internal/server/router.go`, add the import `"github.com/tesserix/kora/api/internal/notifications"` (keep imports sorted). Then, inside the `if deps.DB != nil && deps.Verifier != nil {` block, immediately AFTER the `onboardingHandler := onboarding.NewHandler(userRepo)` line, insert:
```go
			notificationsSvc := notifications.NewService(notifications.NewRepository(deps.DB), groups.NewRepository(deps.DB))
			notificationsHandler := notifications.NewHandler(notificationsSvc)
```
Then, right after the `v1.POST("/onboarding", onboardingHandler.Submit)` line, insert the routes:
```go
			v1.GET("/notifications", notificationsHandler.List)
			v1.GET("/notifications/unread-count", notificationsHandler.UnreadCount)
			v1.POST("/notifications/read", notificationsHandler.MarkAllRead)
```
(`notificationsSvc` is created here — before the social/groups/challenges blocks — so Task 4 can attach it to those services. `groups` is already imported.)

- [ ] **Step 5: Run the full backend suite**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`
Expected: all packages PASS (notifications + server + unaffected). `go build ./...` + `go vet ./...` clean. No route collisions.

- [ ] **Step 6: Commit**

```bash
git add api/internal/notifications/handler.go api/internal/notifications/handler_test.go api/internal/server/router.go
git commit -m "feat(notifications): read API (list/unread-count/mark-all-read) + routes"
```

---

### Task 4: Wire the notifier into social / groups / challenges (best-effort)

**Files:**
- Modify: `api/internal/social/service.go`
- Modify: `api/internal/groups/service.go`
- Modify: `api/internal/challenges/service.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/notifications/wiring_test.go`

**Interfaces:**
- Consumes: the notifier methods on `notifications.Service` (structurally, via per-package interfaces); `notificationsSvc` from Task 3.
- Produces: `WithNotifier` setters on the three services; notifications written on the four events.

- [ ] **Step 1: Add the notifier to `social.Service`**

In `api/internal/social/service.go`: add `"log/slog"` and (if not present) `"context"` to imports. Add the interface + field + setter, and the call sites.

Add near the top (after imports):
```go
type notifier interface {
	FriendRequested(ctx context.Context, recipientID, actorID uuid.UUID) error
	FriendAccepted(ctx context.Context, recipientID, actorID uuid.UUID) error
}
```
Add a `notifier notifier` field to the `Service` struct, and:
```go
func (s Service) WithNotifier(n notifier) Service {
	s.notifier = n
	return s
}
```
In `SendRequest`, on the **new-request** branch, replace the final `return s.repo.Create(...)` with:
```go
	created, err := s.repo.Create(ctx, Friendship{RequesterID: requesterID, AddresseeID: target.ID, Status: FriendStatusPending})
	if err != nil {
		return Friendship{}, err
	}
	if s.notifier != nil {
		if nerr := s.notifier.FriendRequested(ctx, target.ID, requesterID); nerr != nil {
			slog.WarnContext(ctx, "notify friend request failed", "err", nerr)
		}
	}
	return created, nil
```
In `SendRequest`, in the **reverse-pending auto-accept** branch, after `existing.Status = FriendStatusAccepted` (before `return *existing, nil` for that branch), add:
```go
			if s.notifier != nil {
				if nerr := s.notifier.FriendAccepted(ctx, existing.RequesterID, requesterID); nerr != nil {
					slog.WarnContext(ctx, "notify friend accept failed", "err", nerr)
				}
			}
```
(Only inside the `if existing.Status == FriendStatusPending && existing.AddresseeID == requesterID` block — NOT on the idempotent same-direction / already-accepted path.)
In `Accept`, replace `return s.repo.UpdateStatus(ctx, f.ID, FriendStatusAccepted)` with:
```go
	if err := s.repo.UpdateStatus(ctx, f.ID, FriendStatusAccepted); err != nil {
		return err
	}
	if s.notifier != nil {
		if nerr := s.notifier.FriendAccepted(ctx, f.RequesterID, addresseeID); nerr != nil {
			slog.WarnContext(ctx, "notify friend accept failed", "err", nerr)
		}
	}
	return nil
```

- [ ] **Step 2: Add the notifier to `groups.Service`**

In `api/internal/groups/service.go`: add `"log/slog"` to imports. Add:
```go
type notifier interface {
	AddedToGroup(ctx context.Context, recipientID, actorID, groupID uuid.UUID) error
}
```
Add a `notifier notifier` field to the `Service` struct and:
```go
func (s Service) WithNotifier(n notifier) Service {
	s.notifier = n
	return s
}
```
In `InviteFriend`, replace `return s.repo.AddMember(ctx, groupID, friendID, RoleMember)` with:
```go
	if err := s.repo.AddMember(ctx, groupID, friendID, RoleMember); err != nil {
		return err
	}
	if s.notifier != nil {
		if nerr := s.notifier.AddedToGroup(ctx, friendID, ownerID, groupID); nerr != nil {
			slog.WarnContext(ctx, "notify added to group failed", "err", nerr)
		}
	}
	return nil
```

- [ ] **Step 3: Add the notifier to `challenges.Service`**

In `api/internal/challenges/service.go`: add `"log/slog"` to imports. Add:
```go
type notifier interface {
	ChallengeCreated(ctx context.Context, groupID, actorID, challengeID uuid.UUID) error
}
```
Add a `notifier notifier` field to the `Service` struct and:
```go
func (s Service) WithNotifier(n notifier) Service {
	s.notifier = n
	return s
}
```
In `Create`, replace the final `return s.repo.Create(ctx, groupID, userID, title, metric, start, end)` with:
```go
	ch, err := s.repo.Create(ctx, groupID, userID, title, metric, start, end)
	if err != nil {
		return Challenge{}, err
	}
	if s.notifier != nil {
		if nerr := s.notifier.ChallengeCreated(ctx, groupID, userID, ch.ID); nerr != nil {
			slog.WarnContext(ctx, "notify challenge created failed", "err", nerr)
		}
	}
	return ch, nil
```

- [ ] **Step 4: Attach the notifier in `router.go`**

In `api/internal/server/router.go`, update the three service constructions to append `.WithNotifier(notificationsSvc)` (which is in scope from Task 3):
- `social.NewHandler(social.NewService(socialRepo, userRepo))` → `social.NewHandler(social.NewService(socialRepo, userRepo).WithNotifier(notificationsSvc))`
- `groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode)` → `groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode).WithNotifier(notificationsSvc)`
- `challenges.NewService(challengesRepo, groupsRepo, logRepo)` → `challenges.NewService(challengesRepo, groupsRepo, logRepo).WithNotifier(notificationsSvc)`

- [ ] **Step 5: Write the integration test**

`api/internal/notifications/wiring_test.go`:
```go
package notifications_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"os"

	"github.com/tesserix/kora/api/internal/notifications"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

func wiringDB(t *testing.T) *gorm.DB {
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

func seedU(t *testing.T, db *gorm.DB, name, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "wi-"+id.String(), email, name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM notifications WHERE user_id = ? OR actor_id = ?", id, id)
		db.Exec("DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?", id, id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

// failingNotifier proves a notifier error never fails the action.
type failingNotifier struct{}

func (failingNotifier) FriendRequested(context.Context, uuid.UUID, uuid.UUID) error {
	return errors.New("boom")
}
func (failingNotifier) FriendAccepted(context.Context, uuid.UUID, uuid.UUID) error {
	return errors.New("boom")
}

func TestSendRequestWritesFriendRequestNotification(t *testing.T) {
	db := wiringDB(t)
	sender := seedU(t, db, "Sender", "sender-"+uuid.NewString()+"@t.dev")
	recipient := seedU(t, db, "Recipient", "recipient-"+uuid.NewString()+"@t.dev")

	notifSvc := notifications.NewService(notifications.NewRepository(db), nil) // nil members ok — no fan-out here
	svc := social.NewService(social.NewRepository(db), user.NewRepository(db)).WithNotifier(notifSvc)

	var recipEmail string
	require.NoError(t, db.Raw("SELECT email FROM users WHERE id = ?", recipient).Scan(&recipEmail).Error)
	_, err := svc.SendRequest(context.Background(), sender, recipEmail, "")
	require.NoError(t, err)

	list, err := notifications.NewRepository(db).ListForUser(context.Background(), recipient, 50)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, notifications.TypeFriendRequest, list[0].Type)
	require.Equal(t, "Sender", list[0].ActorName)
}

func TestNotifierErrorDoesNotFailAction(t *testing.T) {
	db := wiringDB(t)
	sender := seedU(t, db, "Sender", "s2-"+uuid.NewString()+"@t.dev")
	recipient := seedU(t, db, "Recipient", "r2-"+uuid.NewString()+"@t.dev")
	svc := social.NewService(social.NewRepository(db), user.NewRepository(db)).WithNotifier(failingNotifier{})

	var recipEmail string
	require.NoError(t, db.Raw("SELECT email FROM users WHERE id = ?", recipient).Scan(&recipEmail).Error)
	_, err := svc.SendRequest(context.Background(), sender, recipEmail, "")
	require.NoError(t, err) // action succeeds despite the notifier error
}
```

Note: this test is in package `notifications_test` (external) to avoid an import cycle (it imports `social`, which will structurally satisfy the notifier via `notifications.Service`). If `social.NewService(...).WithNotifier(notifSvc)` does not compile because `notifications.Service` doesn't satisfy `social`'s private `notifier` interface, that indicates a signature mismatch to fix (the method sets must match exactly).

- [ ] **Step 6: Run the tests**

Run the touched packages FOREGROUND:
`cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/ ./internal/groups/ ./internal/challenges/ ./internal/notifications/ ./internal/server/`
Then the full suite: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`
Expected: all PASS (existing social/groups/challenges tests unchanged and green since the notifier defaults nil; new wiring tests green). `go build ./...` + `go vet ./...` clean.

- [ ] **Step 7: Commit**

```bash
git add api/internal/social/service.go api/internal/groups/service.go api/internal/challenges/service.go api/internal/server/router.go api/internal/notifications/wiring_test.go
git commit -m "feat(notifications): best-effort notifier wired into social/groups/challenges"
```

---

### Task 5: Mobile types + notification hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces: types `NotificationType`, `AppNotification`; hooks `useNotifications()`, `useUnreadCount()`, `useMarkAllRead()`.

- [ ] **Step 1: Add types**

Append to `apps/mobile/src/api/types.ts`:
```typescript
export type NotificationType = "friend_request" | "friend_accept" | "group_invite" | "challenge_created";

export interface AppNotification {
  id: string;
  type: NotificationType;
  actor_id: string;
  actor_name: string;
  entity_id?: string;
  read: boolean;
  created_at: string;
}
```

- [ ] **Step 2: Write the failing hook tests**

In `apps/mobile/src/api/__tests__/hooks.test.tsx`, import the new hooks from `../hooks` and append:
```typescript
test("useNotifications fetches /v1/notifications", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce([]);
  const { result } = await renderHook(() => useNotifications(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications");
});

test("useUnreadCount fetches /v1/notifications/unread-count", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ count: 3 });
  const { result } = await renderHook(() => useUnreadCount(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications/unread-count");
  expect(result.current.data?.count).toBe(3);
});

test("useMarkAllRead POSTs /v1/notifications/read", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ marked: 2 });
  const { result } = await renderHook(() => useMarkAllRead(), { wrapper });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/notifications/read", { method: "POST" });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/mobile && npm test -- --ci -t "otification\|nreadCount\|arkAllRead"`
Expected: FAIL — hooks not exported. (If the `-t` pattern is awkward, run the whole file: `npm test -- --ci hooks.test`.)

- [ ] **Step 4: Add the hooks**

In `apps/mobile/src/api/hooks.ts`, add `AppNotification` to the `import type { ... } from "./types"` block (keep alphabetical). Append:
```typescript
export function useNotifications() {
  return useQuery({ queryKey: ["notifications"], queryFn: () => apiFetch("/v1/notifications") as Promise<AppNotification[]> });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => apiFetch("/v1/notifications/unread-count") as Promise<{ count: number }>,
    refetchInterval: 60000,
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/v1/notifications/read", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications", "unread"] });
    },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci hooks.test`
Expected: tsc clean; the 3 new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): notification types + hooks"
```

---

### Task 6: `app/notifications.tsx` inbox + More-tab row + bell icon

**Files:**
- Modify: `apps/mobile/src/components/Icon.tsx`
- Create: `apps/mobile/app/notifications.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx`
- Modify: `apps/mobile/app/(tabs)/__tests__/more.test.tsx`
- Test: `apps/mobile/app/__tests__/notifications.test.tsx`

**Interfaces:**
- Consumes: `useNotifications`, `useMarkAllRead`, `useUnreadCount`, `ScreenHeader`, `AppText`, `Icon`, `useTheme`, `router`.
- Produces: the `Notifications` inbox screen (file-routed), a More row, and a registered `bell` icon.

- [ ] **Step 1: Register the `bell` icon**

In `apps/mobile/src/components/Icon.tsx`, add `Bell` to the `lucide-react-native` import list and `bell: Bell,` to the `MAP` object.

- [ ] **Step 2: Write the failing notifications-screen test**

`apps/mobile/app/__tests__/notifications.test.tsx`:
```typescript
import { fireEvent, render } from "@testing-library/react-native";

const mockPush = jest.fn();
const mockMarkAll = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useNotifications: () => ({
    data: [
      { id: "n1", type: "friend_request", actor_id: "u2", actor_name: "Alice", read: false, created_at: "2026-07-26T00:00:00Z" },
      { id: "n2", type: "challenge_created", actor_id: "u3", actor_name: "Bob", entity_id: "c9", read: true, created_at: "2026-07-25T00:00:00Z" },
    ],
  }),
  useMarkAllRead: () => ({ mutate: mockMarkAll }),
}));

import NotificationsScreen from "../notifications";

beforeEach(() => {
  mockPush.mockReset();
  mockMarkAll.mockReset();
});

test("marks all read on mount and renders per-type messages", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  expect(mockMarkAll).toHaveBeenCalled();
  expect(getByText("Alice sent you a friend request")).toBeTruthy();
  expect(getByText("Bob started a challenge")).toBeTruthy();
});

test("tapping a challenge notification deep-links to the challenge", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  await fireEvent.press(getByText("Bob started a challenge"));
  expect(mockPush).toHaveBeenCalledWith("/challenge/c9");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/mobile && npm test -- --ci notifications.test`
Expected: FAIL — screen module not found.

- [ ] **Step 4: Write `app/notifications.tsx`**

`apps/mobile/app/notifications.tsx`:
```typescript
import { useEffect } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useNotifications, useMarkAllRead } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { AppNotification } from "@/api/types";

function message(n: AppNotification): string {
  switch (n.type) {
    case "friend_request":
      return `${n.actor_name} sent you a friend request`;
    case "friend_accept":
      return `${n.actor_name} accepted your friend request`;
    case "group_invite":
      return `${n.actor_name} added you to a group`;
    case "challenge_created":
      return `${n.actor_name} started a challenge`;
    default:
      return n.actor_name;
  }
}

function targetFor(n: AppNotification): Href | null {
  switch (n.type) {
    case "friend_request":
    case "friend_accept":
      return "/friends" as Href;
    case "group_invite":
      return n.entity_id ? (`/group/${n.entity_id}` as Href) : null;
    case "challenge_created":
      return n.entity_id ? (`/challenge/${n.entity_id}` as Href) : null;
    default:
      return null;
  }
}

export default function NotificationsScreen() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const notifications = useNotifications();
  const markAll = useMarkAllRead();

  // Opening the inbox clears the unread badge. Rows keep their unread styling
  // from this fetch (taken before the mark), so the visual "new" state persists
  // for this viewing.
  useEffect(() => {
    markAll.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = notifications.data ?? [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Recent" title="Notifications" onBack={() => router.back()} />
      <View style={{ paddingHorizontal: 20, gap: 10 }}>
        {list.length === 0 ? (
          <AppText muted style={{ paddingVertical: 12 }}>Nothing yet. Friend requests, group invites, and new challenges show up here.</AppText>
        ) : (
          list.map((n) => {
            const target = targetFor(n);
            return (
              <Pressable
                key={n.id}
                accessibilityRole="button"
                disabled={!target}
                onPress={() => target && router.push(target)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                {!n.read ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} /> : <View style={{ width: 8 }} />}
                <AppText style={{ flex: 1, fontSize: 14, fontWeight: n.read ? "400" : "600" }}>{message(n)}</AppText>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 5: Run the screen test to verify it passes**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci notifications.test`
Expected: tsc clean; 2 tests PASS.

- [ ] **Step 6: Add the Notifications row to the More screen**

In `apps/mobile/app/(tabs)/more.tsx`: import the hook and render a Notifications row with the unread count. Add near the other imports:
```typescript
import { useUnreadCount } from "@/api/hooks";
```
Inside the component, add:
```typescript
  const unread = useUnreadCount();
  const count = unread.data?.count ?? 0;
```
Then, inside the `<View style={{ paddingHorizontal: 20, gap: spacing.sm }}>`, as the FIRST child (before `{ROWS.map(...)}`), add:
```typescript
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/notifications" as Href)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
        >
          <Icon name="bell" size={20} color={colors.primary} />
          <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>Notifications</AppText>
          {count > 0 ? <AppText muted style={{ fontSize: 13 }}>{count}</AppText> : null}
        </Pressable>
```

- [ ] **Step 7: Update the more.test mock + assertion**

In `apps/mobile/app/(tabs)/__tests__/more.test.tsx`, add a mock for `@/api/hooks` (the screen now calls `useUnreadCount`):
```typescript
jest.mock("@/api/hooks", () => ({ useUnreadCount: () => ({ data: { count: 2 } }) }));
```
Add a test:
```typescript
test("tapping Notifications navigates to /notifications", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Notifications"));
  expect(mockPush).toHaveBeenCalledWith("/notifications");
});
```

- [ ] **Step 8: Run mobile checks**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; whole suite PASS (notifications, more, hooks all green).

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src/components/Icon.tsx apps/mobile/app/notifications.tsx apps/mobile/app/(tabs)/more.tsx apps/mobile/app/(tabs)/__tests__/more.test.tsx apps/mobile/app/__tests__/notifications.test.tsx
git commit -m "feat(mobile): notifications inbox screen + More row + bell icon"
```

---

### Task 7: Unread badge dot on the More tab icon

**Files:**
- Modify: `apps/mobile/src/components/FloatingTabBar.tsx`
- Modify: `apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx`

**Interfaces:**
- Consumes: `useUnreadCount`.
- Produces: an unread badge dot overlaid on the More tab icon when count > 0.

- [ ] **Step 1: Add the badge to `FloatingTabBar`**

In `apps/mobile/src/components/FloatingTabBar.tsx`:
1. Add the import:
```typescript
import { useUnreadCount } from "@/api/hooks";
```
2. Inside `FloatingTabBar`, after `const activeName = ...`, add:
```typescript
  const unread = useUnreadCount();
  const unreadCount = unread.data?.count ?? 0;
```
3. In the `tab(name)` helper, wrap the `<Icon .../>` so the `more` tab shows a dot. Replace the `<Icon .../>` line inside the returned `<Pressable>` with:
```typescript
        <View>
          <Icon name={meta.icon} size={22} color={on ? colors.primary : colors.mutedForeground} strokeWidth={on ? 2.5 : 2} />
          {name === "more" && unreadCount > 0 ? (
            <View style={{ position: "absolute", top: -2, right: -2, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, borderWidth: 1.5, borderColor: colors.card }} />
          ) : null}
        </View>
```
(Ensure `View` is imported from `react-native` — it already is.)

- [ ] **Step 2: Update the FloatingTabBar test mock**

In `apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx`, add a mock for the hook (the component now calls it) at the top with the other `jest.mock`s:
```typescript
jest.mock("@/api/hooks", () => ({ useUnreadCount: () => ({ data: { count: 0 } }) }));
```

- [ ] **Step 3: Run mobile checks**

Run: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci`
Expected: tsc clean; whole suite green (existing FloatingTabBar tests still pass — badge hidden at count 0).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/components/FloatingTabBar.tsx apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx
git commit -m "feat(mobile): unread badge dot on the More tab icon"
```

---

## After the tasks

Run the **final whole-branch review on opus** over `main..HEAD`, focused on: (1) best-effort/nil-safe wiring — a notifier error never fails the action, unwired = no-op, existing service tests untouched; (2) user-scoping of every read; (3) the auto-accept edge fires `friend_accept` not `friend_request`, idempotent re-sends fire nothing; (4) challenge fan-out excludes the creator; (5) no route collisions and clean cross-layer JSON↔TS coherence. Fold any Critical/Important findings before proposing the FF-merge to `main` (user-directed).

## Self-Review notes (author)

- **Spec coverage:** migration+model+repo (T1); service notifier methods + fan-out + read pass-throughs (T2); read API + routes (T3); best-effort wiring into the three services + integration tests (T4); mobile types+hooks (T5); inbox screen + More row + bell (T6); tab badge (T7). Privacy/user-scoping covered by T1 `TestListIsUserScoped` + T3; best-effort covered by T4 `TestNotifierErrorDoesNotFailAction`; auto-accept edge covered by the T4 call-site spec (and exercisable via a follow-up test if desired).
- **Type consistency:** `Notification`/`NotificationView`/type consts identical across T1→T4; `store`/`memberLister` interfaces match `Repository`/`groups.Repository`; the three per-package `notifier` interfaces exactly match `notifications.Service`'s method sets (compile-checked by the router wiring in T4 Step 4 and the T4 integration test). Mobile `AppNotification`/`NotificationType` identical across T5→T7; hook keys (`["notifications"]`, `["notifications","unread"]`) consistent between producer and consumers.
- **Known small tradeoffs (flag at final review, not blockers):** `SendRequest` returns the created friendship — the new-request branch now captures it into `created` before notifying (a 1-line refactor of the existing `return s.repo.Create(...)`); the auto-accept notify sits inside the existing reverse-pending block only. The badge polls every 60s (no real-time) — accepted per spec.
