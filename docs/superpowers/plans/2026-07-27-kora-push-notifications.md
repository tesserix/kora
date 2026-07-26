# Kora Phase 10 — OS Push (E2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ready-but-inert OS-push plumbing — a durable push outbox dispatcher, device-token storage/endpoints, a mockable Expo sender, and mobile registration + deep-link wiring — all off by default until the user supplies EAS/APNs credentials.

**Architecture:** Every notification row (E1 action-triggers + E2a scheduler) is born in `notifications.Repository.Create`. A new `internal/push` dispatcher ticker (own goroutine in `main.go`, mirroring the E2a scheduler's notify-then-mark idempotency) scans rows with `push_sent_at IS NULL` inside a freshness window, sends via a `Sender` interface (Expo HTTP impl, mockable), and marks them sent. A `PUSH_ENABLED` flag gates only the dispatcher; device-token registration endpoints mount always. Mobile registers an Expo push token on sign-in (guarded on the EAS `projectId` so it's a silent no-op until `eas init`), de-registers on sign-out, and deep-links on notification tap.

**Tech Stack:** Go 1.26 + Gin + GORM (Postgres/pgvector), `golang-migrate`; Expo SDK 57 (`expo-notifications`, `expo-device`), React Native, React Query, Firebase Auth, Jest + `@testing-library/react-native` v14.

## Global Constraints

- **Go:** 1.26; `gofmt` + `go vet ./...` clean; backend DB tests run FOREGROUND with `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`.
- **Apply new migration to `kora_test` first:** `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate` before running T1 DB tests.
- **Stale RED Go LSP diagnostics after a test-before-impl task are always stale — verify with `go build ./...` / `go test`, never the LSP.**
- **Mobile:** `npx tsc --noEmit` + `npm test -- --ci` both green. No `any`, no `console.log`, no `oklch`; theme tokens only. Read the exact Expo v57 docs (https://docs.expo.dev/versions/v57.0.0/) before writing native-module code — the SDK's API differs from older versions.
- **GORM gotcha:** a bare `time.Time` on a `DEFAULT now()` column inserts the Go zero time and overrides the default — tag timestamps `gorm:"autoCreateTime"` / `gorm:"autoUpdateTime"`.
- **Migration numbering:** next is `000015`. Down migrations reversible with `IF EXISTS`.
- **Copy:** push body strings mirror the in-app `message()` copy in `app/notifications.tsx` verbatim (including `challenge_created` → "started a challenge"). Push title is `"Kora"`.
- **Inert-by-default:** `PUSH_ENABLED=false` default → no dispatcher, no Expo calls. Mobile guards on `Constants.expoConfig.extra.eas.projectId` → no token fetch when absent. Zero behavior change until the user opts in.
- **Commits:** conventional, single-line, no signature.

---

## File Structure

**Backend (create)**
- `api/internal/database/migrations/000015_push.up.sql` / `.down.sql` — `device_tokens` table + `notifications.push_sent_at` column.
- `api/internal/devices/model.go` — `DeviceToken`.
- `api/internal/devices/repository.go` — `Upsert`, `DeleteByToken`, `DeleteToken`, `ListForUser`.
- `api/internal/devices/repository_test.go`, `api/internal/devices/handler.go`, `api/internal/devices/handler_test.go`.
- `api/internal/push/sender.go` — `Message`, `Receipt`, `Sender`, `NoopSender`.
- `api/internal/push/expo.go` — `ExpoSender`.
- `api/internal/push/copy.go` — push title/body/data builders.
- `api/internal/push/dispatcher.go` — `Dispatcher`, ports, `Tick`, `Run`.
- `api/internal/push/dispatcher_test.go`, `api/internal/push/expo_test.go`.

**Backend (modify)**
- `api/internal/notifications/model.go` — add `PushSentAt`.
- `api/internal/notifications/repository.go` — add `PendingPush`, `SkipStalePush`, `ListPendingPush`, `MarkPushSent`.
- `api/internal/notifications/repository_test.go` — outbox tests.
- `api/internal/config/config.go` + `config_test.go` — `PushEnabled`/`PushInterval`/`PushFreshness`/`ExpoAccessToken`.
- `api/internal/server/router.go` — mount `POST /v1/devices`, `DELETE /v1/devices/:token`.
- `api/cmd/api/main.go` — start the dispatcher when `PushEnabled`.

**Mobile (create)**
- `apps/mobile/src/lib/pushApi.ts` — `registerDevice`, `unregisterDevice`.
- `apps/mobile/src/lib/push.ts` — `registerPushToken`, `unregisterPushToken`, `usePushRegistration`, `setupPushHandler`, `usePushResponder`.
- `apps/mobile/src/lib/notificationTarget.ts` — extracted `targetFor`.
- `apps/mobile/src/lib/__tests__/push.test.ts`, `apps/mobile/src/lib/__tests__/notificationTarget.test.ts`.

**Mobile (modify)**
- `apps/mobile/package.json` (+ lockfile) — `expo-notifications`, `expo-device`.
- `apps/mobile/app.json` — `expo-notifications` plugin.
- `apps/mobile/jest.setup.js` — mocks for the new native modules + `expo-constants`.
- `apps/mobile/app/notifications.tsx` — import shared `targetFor`.
- `apps/mobile/app/(tabs)/_layout.tsx` — call `usePushRegistration()` + `usePushResponder()`.
- `apps/mobile/app/_layout.tsx` — call `setupPushHandler()` once.
- `apps/mobile/app/(tabs)/more.tsx` — unregister token before sign-out.

---

## Task 1: Data model + repositories

**Files:**
- Create: `api/internal/database/migrations/000015_push.up.sql`, `api/internal/database/migrations/000015_push.down.sql`
- Create: `api/internal/devices/model.go`, `api/internal/devices/repository.go`, `api/internal/devices/repository_test.go`
- Modify: `api/internal/notifications/model.go`, `api/internal/notifications/repository.go`, `api/internal/notifications/repository_test.go`

**Interfaces:**
- Produces:
  - `devices.DeviceToken{ID, UserID uuid.UUID, Token, Platform string, CreatedAt, UpdatedAt time.Time}`
  - `devices.NewRepository(db *gorm.DB) devices.Repository`
  - `devices.Repository.Upsert(ctx, userID uuid.UUID, token, platform string) error`
  - `devices.Repository.DeleteByToken(ctx, userID uuid.UUID, token string) error`
  - `devices.Repository.DeleteToken(ctx, token string) error`
  - `devices.Repository.ListForUser(ctx, userID uuid.UUID) ([]devices.DeviceToken, error)`
  - `notifications.PendingPush{ID, UserID uuid.UUID, Type, ActorName string, EntityID *uuid.UUID}`
  - `notifications.Repository.SkipStalePush(ctx, cutoff time.Time) (int, error)`
  - `notifications.Repository.ListPendingPush(ctx, since time.Time, limit int) ([]notifications.PendingPush, error)`
  - `notifications.Repository.MarkPushSent(ctx, id uuid.UUID) error`

- [ ] **Step 1: Write the migration files**

Create `api/internal/database/migrations/000015_push.up.sql`:

```sql
CREATE TABLE device_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    platform text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_device_tokens_user ON device_tokens (user_id);

ALTER TABLE notifications ADD COLUMN push_sent_at TIMESTAMPTZ;
```

Create `api/internal/database/migrations/000015_push.down.sql`:

```sql
ALTER TABLE notifications DROP COLUMN IF EXISTS push_sent_at;
DROP TABLE IF EXISTS device_tokens;
```

- [ ] **Step 2: Apply the migration to kora_test**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate
```
Expected: migration output ending at version 15, no error.

- [ ] **Step 3: Add the PushSentAt field to the notifications model**

In `api/internal/notifications/model.go`, add the field to `Notification` (after `CreatedAt`):

```go
	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`
	PushSentAt *time.Time `gorm:"column:push_sent_at" json:"-"`
```

- [ ] **Step 4: Write the failing devices repository test**

Create `api/internal/devices/repository_test.go`:

```go
package devices

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
		id, "dv-"+id.String(), "dv-"+id.String()+"@test.dev", name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM device_tokens WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestUpsertReassignsTokenToNewUser(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	bob := seedUser(t, db, "Bob")
	ctx := context.Background()
	tok := "ExponentPushToken[" + uuid.NewString() + "]"

	require.NoError(t, repo.Upsert(ctx, alice, tok, "ios"))
	require.NoError(t, repo.Upsert(ctx, bob, tok, "android")) // same token, new user

	aliceTokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 0, "token reassigned away from alice")

	bobTokens, err := repo.ListForUser(ctx, bob)
	require.NoError(t, err)
	require.Len(t, bobTokens, 1)
	require.Equal(t, "android", bobTokens[0].Platform)
}

func TestDeleteByTokenIsUserScoped(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	bob := seedUser(t, db, "Bob")
	ctx := context.Background()
	aTok := "ExponentPushToken[" + uuid.NewString() + "]"
	bTok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, repo.Upsert(ctx, alice, aTok, "ios"))
	require.NoError(t, repo.Upsert(ctx, bob, bTok, "ios"))

	// bob cannot delete alice's token binding
	require.NoError(t, repo.DeleteByToken(ctx, bob, aTok))
	aliceTokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 1, "alice's token survives another user's delete")

	// alice deletes her own
	require.NoError(t, repo.DeleteByToken(ctx, alice, aTok))
	aliceTokens, err = repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, aliceTokens, 0)
}

func TestDeleteTokenPrunesRegardlessOfUser(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	alice := seedUser(t, db, "Alice")
	ctx := context.Background()
	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, repo.Upsert(ctx, alice, tok, "ios"))

	require.NoError(t, repo.DeleteToken(ctx, tok)) // prune path (no user scope)
	tokens, err := repo.ListForUser(ctx, alice)
	require.NoError(t, err)
	require.Len(t, tokens, 0)
}
```

- [ ] **Step 5: Run the test to verify it fails**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/devices/ -run TestUpsert -v
```
Expected: compile failure (`undefined: NewRepository`).

- [ ] **Step 6: Write the devices model and repository**

Create `api/internal/devices/model.go`:

```go
// Package devices owns Expo push-token storage for OS notifications.
package devices

import (
	"time"

	"github.com/google/uuid"
)

type DeviceToken struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID `json:"user_id"`
	Token     string    `json:"token"`
	Platform  string    `json:"platform"`
	CreatedAt time.Time `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"autoUpdateTime" json:"updated_at"`
}
```

Create `api/internal/devices/repository.go`:

```go
package devices

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Upsert stores a token for a user, reassigning it if the same physical token
// was previously bound to a different account (shared/reset device).
func (r Repository) Upsert(ctx context.Context, userID uuid.UUID, token, platform string) error {
	dt := DeviceToken{UserID: userID, Token: token, Platform: platform}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "token"}},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":    userID,
				"platform":   platform,
				"updated_at": gorm.Expr("now()"),
			}),
		}).
		Create(&dt).Error
	if err != nil {
		return fmt.Errorf("devices: upsert: %w", err)
	}
	return nil
}

// DeleteByToken removes a token binding only if it belongs to userID (the
// caller may only unregister their own device).
func (r Repository) DeleteByToken(ctx context.Context, userID uuid.UUID, token string) error {
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND token = ?", userID, token).
		Delete(&DeviceToken{}).Error; err != nil {
		return fmt.Errorf("devices: delete by token: %w", err)
	}
	return nil
}

// DeleteToken prunes a token regardless of owner (used when Expo reports it as
// DeviceNotRegistered).
func (r Repository) DeleteToken(ctx context.Context, token string) error {
	if err := r.db.WithContext(ctx).
		Where("token = ?", token).
		Delete(&DeviceToken{}).Error; err != nil {
		return fmt.Errorf("devices: delete token: %w", err)
	}
	return nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]DeviceToken, error) {
	out := []DeviceToken{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("devices: list for user: %w", err)
	}
	return out, nil
}
```

- [ ] **Step 7: Run the devices tests to verify they pass**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/devices/ -race -p 1 -v
```
Expected: PASS (3 tests).

- [ ] **Step 8: Write the failing notifications outbox test**

Append to `api/internal/notifications/repository_test.go`:

```go
func TestOutboxSkipStaleAndListPending(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	recipient := seedUser(t, db, "Recipient")
	actor := seedUser(t, db, "Alice")
	ctx := context.Background()

	require.NoError(t, repo.Create(ctx, Notification{UserID: recipient, ActorID: actor, Type: TypeFriendRequest}))
	freshID, err := repo.ListForUser(ctx, recipient, 1)
	require.NoError(t, err)
	require.Len(t, freshID, 1)

	// Backdate one row so it is older than the cutoff (stale).
	staleGID := uuid.New()
	require.NoError(t, repo.Create(ctx, Notification{UserID: recipient, ActorID: actor, Type: TypeGroupInvite, EntityID: &staleGID}))
	require.NoError(t, db.Exec(
		"UPDATE notifications SET created_at = now() - interval '1 hour' WHERE user_id = ? AND type = ?",
		recipient, TypeGroupInvite).Error)

	cutoff := time.Now().Add(-15 * time.Minute)

	// Skip stale marks the backdated row sent (skipped) without listing it.
	// (SkipStalePush is global; assert it retired at least our stale row.)
	skipped, err := repo.SkipStalePush(ctx, cutoff)
	require.NoError(t, err)
	require.GreaterOrEqual(t, skipped, 1)

	// ListPendingPush is global (not user-scoped), so scope assertions to our
	// recipient to stay robust against other rows in the shared test DB.
	pending, err := repo.ListPendingPush(ctx, cutoff, 500)
	require.NoError(t, err)
	mine := []PendingPush{}
	for _, p := range pending {
		if p.UserID == recipient {
			mine = append(mine, p)
		}
	}
	require.Len(t, mine, 1, "only the fresh row is pending; the stale one was skipped")
	require.Equal(t, TypeFriendRequest, mine[0].Type)
	require.Equal(t, "Alice", mine[0].ActorName)

	// Marking it sent removes it from the pending set.
	require.NoError(t, repo.MarkPushSent(ctx, mine[0].ID))
	pending, err = repo.ListPendingPush(ctx, cutoff, 500)
	require.NoError(t, err)
	for _, p := range pending {
		require.NotEqual(t, recipient, p.UserID, "recipient has no pending rows after mark")
	}
}
```

Add `"time"` to the test file's imports.

- [ ] **Step 9: Run the test to verify it fails**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/notifications/ -run TestOutbox -v
```
Expected: compile failure (`repo.SkipStalePush undefined`).

- [ ] **Step 10: Implement the notifications outbox methods**

Append to `api/internal/notifications/repository.go` (add `"time"` to imports):

```go
// PendingPush is a notification awaiting an OS push, with the actor's name
// joined for the push body.
type PendingPush struct {
	ID        uuid.UUID  `json:"id"`
	UserID    uuid.UUID  `json:"user_id"`
	Type      string     `json:"type"`
	ActorName string     `json:"actor_name"`
	EntityID  *uuid.UUID `json:"entity_id"`
}

// SkipStalePush marks unsent rows older than cutoff as sent without pushing
// them — the freshness guard against a stale-push stampede. Returns the count.
func (r Repository) SkipStalePush(ctx context.Context, cutoff time.Time) (int, error) {
	res := r.db.WithContext(ctx).Model(&Notification{}).
		Where("push_sent_at IS NULL AND created_at <= ?", cutoff).
		Update("push_sent_at", gorm.Expr("now()"))
	if res.Error != nil {
		return 0, fmt.Errorf("notifications: skip stale push: %w", res.Error)
	}
	return int(res.RowsAffected), nil
}

// ListPendingPush returns unsent rows newer than since (the freshness window),
// oldest first, with the actor display name joined in.
func (r Repository) ListPendingPush(ctx context.Context, since time.Time, limit int) ([]PendingPush, error) {
	out := []PendingPush{}
	err := r.db.WithContext(ctx).
		Table("notifications AS n").
		Select("n.id AS id, n.user_id AS user_id, n.type AS type, u.display_name AS actor_name, n.entity_id AS entity_id").
		Joins("JOIN users u ON u.id = n.actor_id").
		Where("n.push_sent_at IS NULL AND n.created_at > ?", since).
		Order("n.created_at ASC").
		Limit(limit).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("notifications: list pending push: %w", err)
	}
	return out, nil
}

func (r Repository) MarkPushSent(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Model(&Notification{}).
		Where("id = ?", id).
		Update("push_sent_at", gorm.Expr("now()")).Error; err != nil {
		return fmt.Errorf("notifications: mark push sent: %w", err)
	}
	return nil
}
```

- [ ] **Step 11: Run both packages' tests + build**

Run:
```bash
cd api && gofmt -w internal/devices internal/notifications && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/notifications/ ./internal/devices/ -race -p 1 && go vet ./internal/devices/... ./internal/notifications/...
```
Expected: all PASS; vet clean.

- [ ] **Step 12: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/database/migrations/000015_push.up.sql api/internal/database/migrations/000015_push.down.sql api/internal/devices api/internal/notifications
git commit -m "feat(push): device_tokens + notifications outbox columns and repos"
```

---

## Task 2: internal/push — sender + dispatcher

**Files:**
- Create: `api/internal/push/sender.go`, `api/internal/push/expo.go`, `api/internal/push/copy.go`, `api/internal/push/dispatcher.go`
- Create: `api/internal/push/dispatcher_test.go`, `api/internal/push/expo_test.go`

**Interfaces:**
- Consumes: `notifications.PendingPush`, `notifications.Type*` consts; `devices.DeviceToken` (from Task 1).
- Produces:
  - `push.Message{To, Title, Body string, Data map[string]any}`
  - `push.Receipt{Token string, DeviceNotRegistered bool}`
  - `push.Sender` interface: `Send(ctx, []Message) ([]Receipt, error)`
  - `push.NoopSender` (satisfies `Sender`)
  - `push.NewExpoSender(accessToken string) *push.ExpoSender` (satisfies `Sender`)
  - `push.New(store pendingStore, tokens tokenLister, sender Sender, freshness, interval time.Duration, log *slog.Logger) *push.Dispatcher`
  - `push.Dispatcher.Tick(ctx, now time.Time) error`, `push.Dispatcher.Run(ctx)`
  - where `pendingStore` = `{SkipStalePush; ListPendingPush; MarkPushSent}` (satisfied by `notifications.Repository`) and `tokenLister` = `{ListForUser; DeleteToken}` (satisfied by `devices.Repository`).

- [ ] **Step 1: Write the sender types and NoopSender**

Create `api/internal/push/sender.go`:

```go
// Package push turns notification rows into OS pushes via a dispatcher ticker.
package push

import "context"

// Message is a single push to one device token.
type Message struct {
	To    string         `json:"to"`
	Title string         `json:"title"`
	Body  string         `json:"body"`
	Data  map[string]any `json:"data,omitempty"`
}

// Receipt is the per-message delivery result. DeviceNotRegistered signals the
// token is dead and should be pruned.
type Receipt struct {
	Token               string
	DeviceNotRegistered bool
}

// Sender delivers a batch of push messages.
type Sender interface {
	Send(ctx context.Context, messages []Message) ([]Receipt, error)
}

// NoopSender accepts every message and reports success (no pruning). Used in
// tests and as a safe default.
type NoopSender struct{}

func (NoopSender) Send(_ context.Context, messages []Message) ([]Receipt, error) {
	receipts := make([]Receipt, len(messages))
	for i, m := range messages {
		receipts[i] = Receipt{Token: m.To}
	}
	return receipts, nil
}
```

- [ ] **Step 2: Write the copy builders**

Create `api/internal/push/copy.go`:

```go
package push

import (
	"github.com/tesserix/kora/api/internal/notifications"
)

const pushTitle = "Kora"

// body mirrors the in-app message() copy in app/notifications.tsx verbatim.
func body(nType, actor string) string {
	switch nType {
	case notifications.TypeFriendRequest:
		return actor + " sent you a friend request"
	case notifications.TypeFriendAccept:
		return actor + " accepted your friend request"
	case notifications.TypeGroupInvite:
		return actor + " added you to a group"
	case notifications.TypeChallengeCreated:
		return actor + " started a challenge"
	case notifications.TypeChallengeStarted:
		return "A challenge you joined has started"
	case notifications.TypeChallengeEnded:
		return actor + " won a challenge"
	case notifications.TypeChallengePassed:
		return actor + " passed you in a challenge"
	default:
		return actor
	}
}

// dataFor carries the deep-link payload the mobile responder reads.
func dataFor(p notifications.PendingPush) map[string]any {
	d := map[string]any{"type": p.Type}
	if p.EntityID != nil {
		d["entity_id"] = p.EntityID.String()
	}
	return d
}
```

- [ ] **Step 3: Write the failing dispatcher test**

Create `api/internal/push/dispatcher_test.go`:

```go
package push

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/notifications"
)

func newLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func at() time.Time           { return time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC) }

type stubStore struct {
	pending    []notifications.PendingPush
	skipCutoff time.Time
	listSince  time.Time
	marked     []uuid.UUID
}

func (s *stubStore) SkipStalePush(_ context.Context, cutoff time.Time) (int, error) {
	s.skipCutoff = cutoff
	return 0, nil
}
func (s *stubStore) ListPendingPush(_ context.Context, since time.Time, _ int) ([]notifications.PendingPush, error) {
	s.listSince = since
	return s.pending, nil
}
func (s *stubStore) MarkPushSent(_ context.Context, id uuid.UUID) error {
	s.marked = append(s.marked, id)
	return nil
}

type stubTokens struct {
	byUser map[uuid.UUID][]devices.DeviceToken
	err    error
	pruned []string
}

func (s *stubTokens) ListForUser(_ context.Context, userID uuid.UUID) ([]devices.DeviceToken, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.byUser[userID], nil
}
func (s *stubTokens) DeleteToken(_ context.Context, token string) error {
	s.pruned = append(s.pruned, token)
	return nil
}

type stubSender struct {
	sent      [][]Message
	receipts  []Receipt
	err       error
}

func (s *stubSender) Send(_ context.Context, messages []Message) ([]Receipt, error) {
	s.sent = append(s.sent, messages)
	if s.err != nil {
		return nil, s.err
	}
	if s.receipts != nil {
		return s.receipts, nil
	}
	r := make([]Receipt, len(messages))
	for i, m := range messages {
		r[i] = Receipt{Token: m.To}
	}
	return r, nil
}

func pending(uid uuid.UUID) notifications.PendingPush {
	return notifications.PendingPush{ID: uuid.New(), UserID: uid, Type: notifications.TypeFriendRequest, ActorName: "Alice"}
}

func TestTickSendsFreshAndMarks(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "tok-a"}}}}
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Equal(t, at().Add(-15*time.Minute), store.skipCutoff, "skip-stale cutoff = now - freshness")
	require.Equal(t, at().Add(-15*time.Minute), store.listSince, "list window = now - freshness")
	require.Len(t, sender.sent, 1)
	require.Equal(t, "tok-a", sender.sent[0][0].To)
	require.Equal(t, "Alice sent you a friend request", sender.sent[0][0].Body)
	require.Equal(t, []uuid.UUID{p.ID}, store.marked)
}

func TestTickNoTokensMarksSentWithoutSending(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{}} // no tokens
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, sender.sent, "no send when recipient has no tokens")
	require.Equal(t, []uuid.UUID{p.ID}, store.marked, "still marked sent")
}

func TestTickSendErrorDoesNotMark(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "tok-a"}}}}
	sender := &stubSender{err: errors.New("expo down")}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, store.marked, "send failure leaves row unsent for retry")
}

func TestTickListTokensErrorDoesNotMark(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{err: errors.New("db down")}
	sender := &stubSender{}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Empty(t, store.marked)
	require.Empty(t, sender.sent)
}

func TestTickPrunesDeviceNotRegistered(t *testing.T) {
	uid := uuid.New()
	p := pending(uid)
	store := &stubStore{pending: []notifications.PendingPush{p}}
	tokens := &stubTokens{byUser: map[uuid.UUID][]devices.DeviceToken{uid: {{Token: "dead-tok"}}}}
	sender := &stubSender{receipts: []Receipt{{Token: "dead-tok", DeviceNotRegistered: true}}}
	d := New(store, tokens, sender, 15*time.Minute, time.Minute, newLogger())

	require.NoError(t, d.Tick(context.Background(), at()))
	require.Equal(t, []string{"dead-tok"}, tokens.pruned)
	require.Equal(t, []uuid.UUID{p.ID}, store.marked, "row still marked sent after prune")
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run:
```bash
cd api && go test ./internal/push/ -run TestTick -v
```
Expected: compile failure (`undefined: New`).

- [ ] **Step 5: Write the dispatcher**

Create `api/internal/push/dispatcher.go`:

```go
package push

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/notifications"
)

const pendingLimit = 200

// pendingStore is the notifications outbox surface (notifications.Repository satisfies it).
type pendingStore interface {
	SkipStalePush(ctx context.Context, cutoff time.Time) (int, error)
	ListPendingPush(ctx context.Context, since time.Time, limit int) ([]notifications.PendingPush, error)
	MarkPushSent(ctx context.Context, id uuid.UUID) error
}

// tokenLister lists a user's device tokens and prunes dead ones (devices.Repository satisfies it).
type tokenLister interface {
	ListForUser(ctx context.Context, userID uuid.UUID) ([]devices.DeviceToken, error)
	DeleteToken(ctx context.Context, token string) error
}

type Dispatcher struct {
	store     pendingStore
	tokens    tokenLister
	sender    Sender
	freshness time.Duration
	interval  time.Duration
	log       *slog.Logger
}

func New(store pendingStore, tokens tokenLister, sender Sender, freshness, interval time.Duration, log *slog.Logger) *Dispatcher {
	return &Dispatcher{store: store, tokens: tokens, sender: sender, freshness: freshness, interval: interval, log: log}
}

// Run ticks until ctx is cancelled. A tick error is logged; the loop continues.
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := d.Tick(ctx, time.Now()); err != nil {
				d.log.WarnContext(ctx, "push tick failed", "err", err)
			}
		}
	}
}

// Tick retires stale rows, then sends fresh ones and marks them.
func (d *Dispatcher) Tick(ctx context.Context, now time.Time) error {
	cutoff := now.Add(-d.freshness)

	if _, err := d.store.SkipStalePush(ctx, cutoff); err != nil {
		return err
	}
	pending, err := d.store.ListPendingPush(ctx, cutoff, pendingLimit)
	if err != nil {
		return err
	}

	for _, p := range pending {
		toks, err := d.tokens.ListForUser(ctx, p.UserID)
		if err != nil {
			d.log.WarnContext(ctx, "push: list tokens", "user", p.UserID, "err", err)
			continue // do not mark → retry next tick (until it ages out)
		}
		if len(toks) > 0 {
			msgs := make([]Message, 0, len(toks))
			for _, t := range toks {
				msgs = append(msgs, Message{To: t.Token, Title: pushTitle, Body: body(p.Type, p.ActorName), Data: dataFor(p)})
			}
			receipts, err := d.sender.Send(ctx, msgs)
			if err != nil {
				d.log.WarnContext(ctx, "push: send", "notification", p.ID, "err", err)
				continue // do not mark → retry
			}
			for _, rc := range receipts {
				if rc.DeviceNotRegistered {
					if err := d.tokens.DeleteToken(ctx, rc.Token); err != nil {
						d.log.WarnContext(ctx, "push: prune token", "err", err)
					}
				}
			}
		}
		if err := d.store.MarkPushSent(ctx, p.ID); err != nil {
			d.log.WarnContext(ctx, "push: mark sent", "notification", p.ID, "err", err)
		}
	}
	return nil
}
```

- [ ] **Step 6: Run the dispatcher tests to verify they pass**

Run:
```bash
cd api && go test ./internal/push/ -race -run TestTick -v
```
Expected: PASS (5 tests).

- [ ] **Step 7: Write the failing ExpoSender test**

Create `api/internal/push/expo_test.go`:

```go
package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExpoSenderParsesTicketsAndDeviceNotRegistered(t *testing.T) {
	var received []Message
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"status":"ok","id":"x"},{"status":"error","message":"not registered","details":{"error":"DeviceNotRegistered"}}]}`))
	}))
	defer srv.Close()

	s := NewExpoSender("")
	s.url = srv.URL // override endpoint for the test

	receipts, err := s.Send(context.Background(), []Message{
		{To: "good-tok", Title: "Kora", Body: "hi"},
		{To: "dead-tok", Title: "Kora", Body: "hi"},
	})
	require.NoError(t, err)
	require.Len(t, received, 2)
	require.Len(t, receipts, 2)
	require.Equal(t, "good-tok", receipts[0].Token)
	require.False(t, receipts[0].DeviceNotRegistered)
	require.Equal(t, "dead-tok", receipts[1].Token)
	require.True(t, receipts[1].DeviceNotRegistered)
}
```

- [ ] **Step 8: Run it to verify it fails**

Run:
```bash
cd api && go test ./internal/push/ -run TestExpoSender -v
```
Expected: compile failure (`undefined: NewExpoSender`).

- [ ] **Step 9: Write the ExpoSender**

Create `api/internal/push/expo.go`:

```go
package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"
const expoBatchSize = 100

// ExpoSender delivers pushes through the Expo Push API. It never panics;
// transport/decode errors are returned. An optional access token is sent as a
// Bearer credential when configured.
type ExpoSender struct {
	client *http.Client
	token  string
	url    string
}

func NewExpoSender(accessToken string) *ExpoSender {
	return &ExpoSender{
		client: &http.Client{Timeout: 10 * time.Second},
		token:  accessToken,
		url:    expoPushURL,
	}
}

type expoTicket struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

type expoResponse struct {
	Data []expoTicket `json:"data"`
}

func (s *ExpoSender) Send(ctx context.Context, messages []Message) ([]Receipt, error) {
	receipts := make([]Receipt, 0, len(messages))
	for start := 0; start < len(messages); start += expoBatchSize {
		end := start + expoBatchSize
		if end > len(messages) {
			end = len(messages)
		}
		batch := messages[start:end]
		batchReceipts, err := s.sendBatch(ctx, batch)
		if err != nil {
			return nil, err
		}
		receipts = append(receipts, batchReceipts...)
	}
	return receipts, nil
}

func (s *ExpoSender) sendBatch(ctx context.Context, batch []Message) ([]Receipt, error) {
	payload, err := json.Marshal(batch)
	if err != nil {
		return nil, fmt.Errorf("push: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("push: request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("push: send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("push: expo status %d", resp.StatusCode)
	}
	var body expoResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("push: decode: %w", err)
	}
	receipts := make([]Receipt, len(batch))
	for i, m := range batch {
		receipts[i] = Receipt{Token: m.To}
		if i < len(body.Data) {
			t := body.Data[i]
			receipts[i].DeviceNotRegistered = t.Status == "error" && t.Details.Error == "DeviceNotRegistered"
		}
	}
	return receipts, nil
}
```

- [ ] **Step 10: Run all push tests + gofmt/vet**

Run:
```bash
cd api && gofmt -w internal/push && go test ./internal/push/ -race && go vet ./internal/push/...
```
Expected: PASS (6 tests); vet clean.

- [ ] **Step 11: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/push
git commit -m "feat(push): outbox dispatcher + expo sender (mockable, freshness-windowed)"
```

---

## Task 3: Device endpoints + config + main.go wiring

**Files:**
- Create: `api/internal/devices/handler.go`, `api/internal/devices/handler_test.go`
- Modify: `api/internal/config/config.go`, `api/internal/config/config_test.go`
- Modify: `api/internal/server/router.go`
- Modify: `api/cmd/api/main.go`

**Interfaces:**
- Consumes: `devices.NewRepository`, `push.New`, `push.NewExpoSender`, `notifications.NewRepository` (Tasks 1–2).
- Produces:
  - `devices.NewHandler(repo Repository) devices.Handler`
  - `devices.Handler.Register(c *gin.Context)`, `devices.Handler.Delete(c *gin.Context)`
  - `config.Config` fields `PushEnabled bool`, `PushInterval time.Duration`, `PushFreshness time.Duration`, `ExpoAccessToken string`
  - Routes `POST /v1/devices`, `DELETE /v1/devices/:token`.

- [ ] **Step 1: Write the failing handler test**

Create `api/internal/devices/handler_test.go`:

```go
package devices

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	h := NewHandler(NewRepository(db))
	r.POST("/v1/devices", h.Register)
	r.DELETE("/v1/devices/:token", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestRegisterDevice(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)

	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.Equal(t, http.StatusOK, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"`+tok+`","platform":"ios"}`).Code)

	// blank token → 400
	require.Equal(t, http.StatusBadRequest, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"","platform":"ios"}`).Code)
	// bad platform → 400
	require.Equal(t, http.StatusBadRequest, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"t","platform":"windows"}`).Code)
}

func TestDeleteDevice(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)
	tok := "ExponentPushToken[" + uuid.NewString() + "]"
	require.NoError(t, NewRepository(db).Upsert(t.Context(), me, tok, "ios"))
	// URL-encode the bracketed token in the path segment
	require.Equal(t, http.StatusOK, doJSON(r, http.MethodDelete, "/v1/devices/"+"ExponentPushToken%5Btest%5D", "").Code)
}

func TestRegisterUnauthorized(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	r := gin.New() // no user_id middleware
	h := NewHandler(NewRepository(db))
	r.POST("/v1/devices", h.Register)
	require.Equal(t, http.StatusUnauthorized, doJSON(r, http.MethodPost, "/v1/devices", `{"token":"t","platform":"ios"}`).Code)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/devices/ -run TestRegisterDevice -v
```
Expected: compile failure (`undefined: NewHandler`).

- [ ] **Step 3: Write the handler**

Create `api/internal/devices/handler.go`:

```go
package devices

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	repo Repository
}

func NewHandler(repo Repository) Handler { return Handler{repo: repo} }

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

type registerRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

func (h Handler) Register(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return
	}
	if req.Token == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "token is required")
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "platform must be ios or android")
		return
	}
	if err := h.repo.Upsert(c.Request.Context(), uid, req.Token, req.Platform); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not register device")
		return
	}
	httpx.OK(c, gin.H{"registered": true})
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	token := c.Param("token")
	if token == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "token is required")
		return
	}
	if err := h.repo.DeleteByToken(c.Request.Context(), uid, token); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not remove device")
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
```

- [ ] **Step 4: Run the handler tests to verify they pass**

Run:
```bash
cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test ./internal/devices/ -race -p 1 -v
```
Expected: PASS (all devices tests).

- [ ] **Step 5: Write the failing config test**

Append to `api/internal/config/config_test.go`:

```go
func TestLoadPushDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:pass@localhost/testdb")
	t.Setenv("PUSH_ENABLED", "")
	t.Setenv("PUSH_INTERVAL", "")
	t.Setenv("PUSH_FRESHNESS", "")
	t.Setenv("EXPO_ACCESS_TOKEN", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.False(t, cfg.PushEnabled)
	require.Equal(t, 30*time.Second, cfg.PushInterval)
	require.Equal(t, 15*time.Minute, cfg.PushFreshness)
	require.Equal(t, "", cfg.ExpoAccessToken)
}

func TestLoadPushOverrides(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:pass@localhost/testdb")
	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_INTERVAL", "10s")
	t.Setenv("PUSH_FRESHNESS", "5m")
	t.Setenv("EXPO_ACCESS_TOKEN", "expo-secret")
	cfg, err := Load()
	require.NoError(t, err)
	require.True(t, cfg.PushEnabled)
	require.Equal(t, 10*time.Second, cfg.PushInterval)
	require.Equal(t, 5*time.Minute, cfg.PushFreshness)
	require.Equal(t, "expo-secret", cfg.ExpoAccessToken)
}
```

- [ ] **Step 6: Run it to verify it fails**

Run:
```bash
cd api && go test ./internal/config/ -run TestLoadPush -v
```
Expected: compile failure (`cfg.PushEnabled undefined`).

- [ ] **Step 7: Add the config fields**

In `api/internal/config/config.go`, add to the `Config` struct (after `SchedulerInterval`):

```go
	SchedulerInterval time.Duration
	PushEnabled       bool
	PushInterval      time.Duration
	PushFreshness     time.Duration
	ExpoAccessToken   string
```

And to the `cfg := Config{...}` literal in `Load()` (after `SchedulerInterval`):

```go
		SchedulerInterval: getdur("SCHEDULER_INTERVAL", 5*time.Minute),
		PushEnabled:       os.Getenv("PUSH_ENABLED") == "true",
		PushInterval:      getdur("PUSH_INTERVAL", 30*time.Second),
		PushFreshness:     getdur("PUSH_FRESHNESS", 15*time.Minute),
		ExpoAccessToken:   os.Getenv("EXPO_ACCESS_TOKEN"),
```

- [ ] **Step 8: Run the config tests**

Run:
```bash
cd api && go test ./internal/config/ -v
```
Expected: PASS (existing + 2 new).

- [ ] **Step 9: Mount the device routes**

In `api/internal/server/router.go`, add the `devices` import (keep imports sorted):

```go
	"github.com/tesserix/kora/api/internal/devices"
```

Then, inside the `if deps.DB != nil && deps.Verifier != nil {` block, right after the notifications routes (after line `v1.POST("/notifications/read", notificationsHandler.MarkAllRead)`), add:

```go
			devicesHandler := devices.NewHandler(devices.NewRepository(deps.DB))
			v1.POST("/devices", devicesHandler.Register)
			v1.DELETE("/devices/:token", devicesHandler.Delete)
```

- [ ] **Step 10: Wire the dispatcher in main.go**

In `api/cmd/api/main.go`, add imports (keep sorted):

```go
	"github.com/tesserix/kora/api/internal/devices"
	"github.com/tesserix/kora/api/internal/push"
```

After the scheduler `if cfg.SchedulerInterval > 0 { ... }` block and before the `srv := &http.Server{...}` line, add:

```go
	pushCtx, pushCancel := context.WithCancel(context.Background())
	if cfg.PushEnabled {
		disp := push.New(
			notifications.NewRepository(db),
			devices.NewRepository(db),
			push.NewExpoSender(cfg.ExpoAccessToken),
			cfg.PushFreshness,
			cfg.PushInterval,
			logger,
		)
		go disp.Run(pushCtx)
		logger.Info("push dispatcher started", "interval", cfg.PushInterval.String(), "freshness", cfg.PushFreshness.String())
	}
```

Then in the shutdown sequence, add `pushCancel()` next to the existing `schedCancel()`:

```go
	schedCancel()
	pushCancel()
```

- [ ] **Step 11: Build, vet, and run the full backend suite**

Run:
```bash
cd api && gofmt -w cmd internal && go build ./... && go vet ./... && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...
```
Expected: build ok; vet clean; all packages PASS. (This confirms `notifications.Repository` satisfies `push`'s `pendingStore` and `devices.Repository` satisfies `tokenLister` with no adapters.)

- [ ] **Step 12: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add api/internal/devices api/internal/config api/internal/server/router.go api/cmd/api/main.go
git commit -m "feat(push): device endpoints, PUSH_* config, dispatcher wiring (enabled flag)"
```

---

## Task 4: Mobile deps + config plugin + jest mocks

**Files:**
- Modify: `apps/mobile/package.json` (+ lockfile), `apps/mobile/app.json`, `apps/mobile/jest.setup.js`

**Interfaces:**
- Produces: `expo-notifications` + `expo-device` installed and mocked; `expo-constants` mocked with a controllable `projectId`. No new exported code — the deliverable is a green suite with the new modules available.

- [ ] **Step 1: Install the native modules**

Run:
```bash
cd apps/mobile && npx expo install expo-notifications expo-device
```
Expected: both added to `package.json` dependencies at SDK-57-compatible versions; lockfile updated.

- [ ] **Step 2: Add the config plugin**

In `apps/mobile/app.json`, add `"expo-notifications"` to the `plugins` array (after `"expo-audio"`'s entry):

```json
      [
        "expo-audio",
        {
          "microphonePermission": "Kora uses the microphone so you can describe meals by voice."
        }
      ],
      "expo-notifications"
```

- [ ] **Step 3: Add jest mocks**

Append to `apps/mobile/jest.setup.js`:

```js
// expo-notifications (SDK 57): mock the permission/token/listener surface the
// push registration + responder use. getExpoPushTokenAsync returns { data }.
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: "ExponentPushToken[test]" })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock("expo-device", () => ({ isDevice: true }));

// expo-constants: default export carries expoConfig. Tests mutate
// Constants.expoConfig.extra.eas.projectId to exercise the inert (absent) path.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: "test-project" } } } },
}));
```

- [ ] **Step 4: Verify the suite is still green**

Run:
```bash
cd apps/mobile && npx tsc --noEmit && npm test -- --ci
```
Expected: tsc clean; all existing suites PASS (mocks are inert until Task 5 uses them).

- [ ] **Step 5: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/app.json apps/mobile/jest.setup.js
git commit -m "chore(push): add expo-notifications/expo-device + jest mocks"
```

---

## Task 5: Mobile token registration

**Files:**
- Create: `apps/mobile/src/lib/pushApi.ts`, `apps/mobile/src/lib/push.ts`, `apps/mobile/src/lib/__tests__/push.test.ts`
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`, `apps/mobile/app/(tabs)/more.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api`; `auth`, `isFirebaseConfigured` from `@/lib/firebase`.
- Produces:
  - `registerDevice(token: string, platform: string): Promise<void>` and `unregisterDevice(token: string): Promise<void>` (`@/lib/pushApi`)
  - `registerPushToken(): Promise<void>`, `unregisterPushToken(): Promise<void>`, `usePushRegistration(): void` (`@/lib/push`)

- [ ] **Step 1: Write the device API wrappers**

Create `apps/mobile/src/lib/pushApi.ts`:

```ts
import { apiFetch } from "./api";

export async function registerDevice(token: string, platform: string): Promise<void> {
  await apiFetch("/v1/devices", {
    method: "POST",
    body: JSON.stringify({ token, platform }),
  });
}

export async function unregisterDevice(token: string): Promise<void> {
  await apiFetch(`/v1/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Write the failing push registration test**

Create `apps/mobile/src/lib/__tests__/push.test.ts`:

```ts
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerPushToken, unregisterPushToken } from "../push";
import { registerDevice, unregisterDevice } from "../pushApi";

jest.mock("../pushApi", () => ({
  registerDevice: jest.fn(async () => {}),
  unregisterDevice: jest.fn(async () => {}),
}));

// Firebase is initialised elsewhere; the exported functions under test don't
// touch it, so a light mock keeps the module import clean.
jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));

function setProjectId(id: string | undefined): void {
  (Constants as unknown as { expoConfig: { extra: { eas: { projectId: string | undefined } } } }).expoConfig = {
    extra: { eas: { projectId: id } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setProjectId("test-project");
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted" });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "granted" });
  (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: "ExponentPushToken[abc]" });
});

test("registerPushToken is a no-op when projectId is absent (inert until eas init)", async () => {
  setProjectId(undefined);
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registerDevice).not.toHaveBeenCalled();
});

test("registerPushToken is a no-op when permission is denied", async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied" });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: "denied" });
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(registerDevice).not.toHaveBeenCalled();
});

test("registerPushToken registers the token and caches it on the happy path", async () => {
  await registerPushToken();
  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "test-project" });
  expect(registerDevice).toHaveBeenCalledWith("ExponentPushToken[abc]", expect.any(String));
  expect(await AsyncStorage.getItem("kora.pushToken")).toBe("ExponentPushToken[abc]");
});

test("unregisterPushToken deletes and clears the cached token", async () => {
  await AsyncStorage.setItem("kora.pushToken", "ExponentPushToken[abc]");
  await unregisterPushToken();
  expect(unregisterDevice).toHaveBeenCalledWith("ExponentPushToken[abc]");
  expect(await AsyncStorage.getItem("kora.pushToken")).toBeNull();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
cd apps/mobile && npm test -- --ci src/lib/__tests__/push.test.ts
```
Expected: FAIL (cannot resolve `../push`).

- [ ] **Step 4: Write the push module**

Create `apps/mobile/src/lib/push.ts`:

```ts
import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { registerDevice, unregisterDevice } from "@/lib/pushApi";

const TOKEN_KEY = "kora.pushToken";

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
}

// registerPushToken requests permission, fetches the Expo push token, and
// registers it with the API. It is a silent no-op until the EAS projectId
// exists (i.e. before `eas init`) or if the user denies notifications.
export async function registerPushToken(): Promise<void> {
  const pid = projectId();
  if (!pid) return;

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") return;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pid });
  await AsyncStorage.setItem(TOKEN_KEY, token);
  await registerDevice(token, Platform.OS);
}

// unregisterPushToken removes the device binding for the cached token so a
// shared device stops receiving the previous user's push.
export async function unregisterPushToken(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) return;
  await unregisterDevice(token);
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// usePushRegistration registers the device whenever a user signs in.
export function usePushRegistration(): void {
  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) void registerPushToken();
    });
    return unsub;
  }, []);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd apps/mobile && npm test -- --ci src/lib/__tests__/push.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Wire registration into the signed-in area**

In `apps/mobile/app/(tabs)/_layout.tsx`, add the import and call the hook inside `TabsLayout`:

```ts
import { usePushRegistration } from "@/lib/push";
```

Inside `TabsLayout`, after `const profile = useProfile();`:

```ts
  usePushRegistration();
```

- [ ] **Step 7: Unregister on sign-out**

In `apps/mobile/app/(tabs)/more.tsx`, add the import:

```ts
import { unregisterPushToken } from "@/lib/push";
```

Replace the Sign-out `onPress`:

```ts
          onPress={() => auth && signOut(auth)}
```

with:

```ts
          onPress={async () => {
            if (!auth) return;
            try {
              await unregisterPushToken();
            } catch {
              // best-effort: still sign out even if de-registration fails
            }
            await signOut(auth);
          }}
```

- [ ] **Step 8: Verify tsc + full suite**

Run:
```bash
cd apps/mobile && npx tsc --noEmit && npm test -- --ci
```
Expected: tsc clean; all suites PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/lib/pushApi.ts apps/mobile/src/lib/push.ts apps/mobile/src/lib/__tests__/push.test.ts "apps/mobile/app/(tabs)/_layout.tsx" "apps/mobile/app/(tabs)/more.tsx"
git commit -m "feat(push): mobile token registration on sign-in + de-register on sign-out"
```

---

## Task 6: Mobile foreground handler + deep-link responder

**Files:**
- Create: `apps/mobile/src/lib/notificationTarget.ts`, `apps/mobile/src/lib/__tests__/notificationTarget.test.ts`
- Modify: `apps/mobile/src/lib/push.ts` (add `setupPushHandler` + `usePushResponder`)
- Modify: `apps/mobile/app/notifications.tsx` (use shared `targetFor`)
- Modify: `apps/mobile/app/_layout.tsx` (call `setupPushHandler` once), `apps/mobile/app/(tabs)/_layout.tsx` (call `usePushResponder`)

**Interfaces:**
- Consumes: `AppNotification`/`NotificationType` from `@/api/types`; `Href` from `expo-router`.
- Produces:
  - `targetFor(n: { type: NotificationType; entity_id?: string }): Href | null` (`@/lib/notificationTarget`)
  - `setupPushHandler(): void`, `usePushResponder(): void` (`@/lib/push`)

- [ ] **Step 1: Write the failing targetFor test**

Create `apps/mobile/src/lib/__tests__/notificationTarget.test.ts`:

```ts
import { targetFor } from "../notificationTarget";

test("friend types route to /friends", () => {
  expect(targetFor({ type: "friend_request" })).toBe("/friends");
  expect(targetFor({ type: "friend_accept" })).toBe("/friends");
});

test("group invite routes to the group when entity_id is present", () => {
  expect(targetFor({ type: "group_invite", entity_id: "g1" })).toBe("/group/g1");
  expect(targetFor({ type: "group_invite" })).toBeNull();
});

test("challenge types route to the challenge when entity_id is present", () => {
  expect(targetFor({ type: "challenge_started", entity_id: "c1" })).toBe("/challenge/c1");
  expect(targetFor({ type: "challenge_passed", entity_id: "c2" })).toBe("/challenge/c2");
  expect(targetFor({ type: "challenge_ended" })).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd apps/mobile && npm test -- --ci src/lib/__tests__/notificationTarget.test.ts
```
Expected: FAIL (cannot resolve `../notificationTarget`).

- [ ] **Step 3: Extract targetFor into a shared module**

Create `apps/mobile/src/lib/notificationTarget.ts`:

```ts
import type { Href } from "expo-router";
import type { NotificationType } from "@/api/types";

// targetFor maps a notification to its in-app deep-link target, shared by the
// inbox screen and the OS-push tap responder.
export function targetFor(n: { type: NotificationType; entity_id?: string }): Href | null {
  switch (n.type) {
    case "friend_request":
    case "friend_accept":
      return "/friends" as Href;
    case "group_invite":
      return n.entity_id ? (`/group/${n.entity_id}` as Href) : null;
    case "challenge_created":
    case "challenge_started":
    case "challenge_ended":
    case "challenge_passed":
      return n.entity_id ? (`/challenge/${n.entity_id}` as Href) : null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd apps/mobile && npm test -- --ci src/lib/__tests__/notificationTarget.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Use the shared targetFor in the inbox screen**

In `apps/mobile/app/notifications.tsx`, remove the local `targetFor` function (lines defining `function targetFor(...) { ... }`) and add the import next to the other `@/` imports:

```ts
import { targetFor } from "@/lib/notificationTarget";
```

(The `message()` function stays; only `targetFor` moves.)

- [ ] **Step 6: Add the foreground handler and responder to push.ts**

Append to `apps/mobile/src/lib/push.ts` (add `router` + `targetFor` + `NotificationType` imports at the top):

```ts
import { router } from "expo-router";
import { targetFor } from "@/lib/notificationTarget";
import type { NotificationType } from "@/api/types";
```

Append at the end of the file:

```ts
// setupPushHandler configures how foreground notifications are presented.
// NOTE: verify the exact NotificationBehavior fields against the Expo v57 docs
// (SDK 54+ uses shouldShowBanner/shouldShowList, not shouldShowAlert).
export function setupPushHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// usePushResponder deep-links when the user taps a push.
export function usePushResponder(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as {
        type?: NotificationType;
        entity_id?: string;
      };
      if (!data?.type) return;
      const target = targetFor({ type: data.type, entity_id: data.entity_id });
      if (target) router.push(target);
    });
    return () => sub.remove();
  }, []);
}
```

- [ ] **Step 7: Wire the handler and responder into the app shell**

In `apps/mobile/app/_layout.tsx`, add the import and call `setupPushHandler()` once at module scope (below imports, before `RootLayout`):

```ts
import { setupPushHandler } from "@/lib/push";

setupPushHandler();
```

In `apps/mobile/app/(tabs)/_layout.tsx`, extend the push import and call the responder hook next to `usePushRegistration()`:

```ts
import { usePushRegistration, usePushResponder } from "@/lib/push";
```

```ts
  usePushRegistration();
  usePushResponder();
```

- [ ] **Step 8: Verify tsc + full suite**

Run:
```bash
cd apps/mobile && npx tsc --noEmit && npm test -- --ci
```
Expected: tsc clean; all suites PASS (including the unchanged `notifications.test`).

- [ ] **Step 9: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/lib/notificationTarget.ts apps/mobile/src/lib/__tests__/notificationTarget.test.ts apps/mobile/src/lib/push.ts apps/mobile/app/notifications.tsx apps/mobile/app/_layout.tsx "apps/mobile/app/(tabs)/_layout.tsx"
git commit -m "feat(push): foreground handler + tap deep-link responder (shared targetFor)"
```

---

## Final verification (after all tasks, before whole-branch review)

- [ ] Backend: `cd api && gofmt -w cmd internal && go build ./... && go vet ./... && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...` → all green.
- [ ] Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` → all green.
- [ ] Confirm inert-by-default: with `PUSH_ENABLED` unset, `main.go` logs no "push dispatcher started"; `POST /v1/devices` still mounts (behind auth). With `projectId` absent, `registerPushToken()` fetches no token.
- [ ] Controller: dev-build rebuild (`expo run:ios`) to validate the `expo-notifications` native module links (like the capture modules) — mobile registration stays inert on the simulator without an EAS project; full live push is deferred to the user (eas init + APNs + physical device).

## Post-phase (user-owned, to flip live)

1. `eas init` in `apps/mobile` → `projectId` lands in `app.json` (`extra.eas.projectId`).
2. Configure Apple APNs credentials via EAS + a physical iOS device.
3. Set `PUSH_ENABLED=true` (+ optional `EXPO_ACCESS_TOKEN`) in the API env.
4. Rebuild the dev client, sign in on the device → token registers → the dispatcher delivers real OS pushes.
