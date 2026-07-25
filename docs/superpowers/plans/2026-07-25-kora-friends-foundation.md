# Friends Foundation (Social A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kora social graph — send/accept/decline friend requests (by share-code or email), list friends, unfriend, and a per-user share code — as a new backend `social` domain plus a Friends screen under the mobile More tab.

**Architecture:** New Go package `api/internal/social` (model / repository / service / handler) backed by a `friendships` table and a `users.friend_code` column (migration `000009`), wired into the authed `/v1` group. Mutual request→accept model. Mobile adds seven TanStack Query hooks, a `friends.tsx` screen, an `AddFriendSheet`, and a navigating More row. Foundation exposes only `display_name`+`id` — no health data.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate (Postgres); React Native / Expo (SDK 57), expo-router, TanStack Query v5, Jest + RNTL v14, TypeScript.

## Global Constraints

- Backend DB tests run against `kora_test`, isolated: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...` (Postgres = docker `infra-postgres-1`). Run tests FOREGROUND. Stale RED LSP diagnostics after a test-before-impl step are normal — trust `go build ./...` / `go test`.
- After adding migration files, apply them to `kora_test` before running repo tests: from `api/`, `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`. (When smoking the app locally, also migrate the dev DB `kora`.)
- Handlers resolve the caller via `user.IDFromContext(c)` (context key `user_id`); the mini test router sets `c.Set("user_id", userID)`.
- Response envelope: success `{"data": …}` via `httpx.OK`; errors `{"error":code,"message":…}` via `httpx.Error`. Never leak internal error detail.
- Mobile: `npx tsc --noEmit` + `npm test -- --ci` stay green (currently 153/153). Jest `jest.mock` factories reference only `mock`-prefixed vars.
- Foundation shares NO health data — only `display_name` + `id`.
- Conventional single-line commits, no signature. No pushing until the user approves.
- All commands run from `api/` (backend) or `apps/mobile/` (mobile) as noted.

---

### Task 1: Migration `000009` + `Friendship` model + repository + user lookups

**Files:**
- Create: `api/internal/database/migrations/000009_friendships.up.sql`
- Create: `api/internal/database/migrations/000009_friendships.down.sql`
- Create: `api/internal/social/model.go`
- Create: `api/internal/social/repository.go`
- Modify: `api/internal/user/model.go` (add `FriendCode` field)
- Modify: `api/internal/user/repository.go` (add `ByID`, `FindByEmail`, `FindByCode`, `SetFriendCode`)
- Test: `api/internal/social/repository_test.go`

**Interfaces:**
- Produces (consumed by Task 2):
  - `social.Friendship{ID,RequesterID,AddresseeID uuid.UUID; Status FriendStatus; CreatedAt,UpdatedAt time.Time}`
  - `social.FriendStatus` consts `FriendStatusPending`, `FriendStatusAccepted`
  - `social.FriendView{ID uuid.UUID; DisplayName string}`, `social.RequestView{ID uuid.UUID; User FriendView}`
  - `social.Repository`: `Create(ctx,Friendship)(Friendship,error)`, `FindByPair(ctx,a,b)(*Friendship,error)`, `FindByID(ctx,id)(*Friendship,error)`, `ListAccepted(ctx,userID)([]FriendView,error)`, `ListPending(ctx,userID)(incoming,outgoing []RequestView,error)`, `UpdateStatus(ctx,id,FriendStatus)error`, `Delete(ctx,id)error`
  - `user.Repository`: `ByID(ctx,id)(User,error)`, `FindByEmail(ctx,email)(User,error)`, `FindByCode(ctx,code)(User,error)`, `SetFriendCode(ctx,id,code)error`; `user.User` gains `FriendCode string`

- [ ] **Step 1: Write the migration files.**

`api/internal/database/migrations/000009_friendships.up.sql`:

```sql
CREATE TABLE friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (requester_id <> addressee_id)
);
CREATE UNIQUE INDEX ux_friendships_pair ON friendships (
    LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id)
);
CREATE INDEX ix_friendships_addressee ON friendships (addressee_id);

ALTER TABLE users ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX ux_users_friend_code ON users (friend_code);
```

`api/internal/database/migrations/000009_friendships.down.sql`:

```sql
DROP INDEX IF EXISTS ux_users_friend_code;
ALTER TABLE users DROP COLUMN IF EXISTS friend_code;
DROP TABLE IF EXISTS friendships;
```

- [ ] **Step 2: Apply the migration to `kora_test`.**

Run (from `api/`):
`TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate`
Expected: exits 0, no error. (If it reports "dirty" or a pre-existing `friendships` drift, resolve per the repo's known-drift procedure, then re-run — the migration must apply cleanly.)

- [ ] **Step 3: Create the model.**

`api/internal/social/model.go`:

```go
// Package social owns the friendship graph.
package social

import (
	"time"

	"github.com/google/uuid"
)

type FriendStatus string

const (
	FriendStatusPending  FriendStatus = "pending"
	FriendStatusAccepted FriendStatus = "accepted"
)

type Friendship struct {
	ID          uuid.UUID    `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	RequesterID uuid.UUID    `json:"requester_id"`
	AddresseeID uuid.UUID    `json:"addressee_id"`
	Status      FriendStatus `json:"status"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

// FriendView is the public projection of a user — never exposes email.
type FriendView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}

// RequestView is a pending request plus the other user involved.
type RequestView struct {
	ID   uuid.UUID  `json:"id"`
	User FriendView `json:"user"`
}
```

- [ ] **Step 4: Add the user-model field and repository lookups.**

In `api/internal/user/model.go`, add to the `User` struct (after `DisplayName`):

```go
	FriendCode string `gorm:"uniqueIndex" json:"-"`
```

In `api/internal/user/repository.go`, add these methods (they wrap `gorm.ErrRecordNotFound` via `%w` so callers can detect not-found):

```go
func (r Repository) ByID(ctx context.Context, id uuid.UUID) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).First(&u, "id = ?", id).Error; err != nil {
		return User{}, fmt.Errorf("user: by id: %w", err)
	}
	return u, nil
}

func (r Repository) FindByEmail(ctx context.Context, email string) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).Where("email = ?", email).First(&u).Error; err != nil {
		return User{}, fmt.Errorf("user: by email: %w", err)
	}
	return u, nil
}

func (r Repository) FindByCode(ctx context.Context, code string) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).Where("friend_code = ?", code).First(&u).Error; err != nil {
		return User{}, fmt.Errorf("user: by code: %w", err)
	}
	return u, nil
}

func (r Repository) SetFriendCode(ctx context.Context, id uuid.UUID, code string) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("friend_code", code).Error; err != nil {
		return fmt.Errorf("user: set friend code: %w", err)
	}
	return nil
}
```

- [ ] **Step 5: Write the failing repository test.**

`api/internal/social/repository_test.go`:

```go
package social

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
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
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)",
		id, "so-"+id.String(), "so-"+id.String()+"@test.dev", name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?", id, id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestCreateAndFindByPairEitherDirection(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	repo := NewRepository(db)

	f, err := repo.Create(context.Background(), Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, f.ID)

	// found in the reverse direction too
	got, err := repo.FindByPair(context.Background(), b, a)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, f.ID, got.ID)
}

func TestUniquePairIndexRejectsReverseDuplicate(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	repo := NewRepository(db)
	_, err := repo.Create(context.Background(), Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)
	// reverse insert must violate ux_friendships_pair
	_, err = repo.Create(context.Background(), Friendship{RequesterID: b, AddresseeID: a, Status: FriendStatusPending})
	require.Error(t, err)
}

func TestListAcceptedAndPending(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	friend := seedUser(t, db, "Friend")
	requester := seedUser(t, db, "Requester")
	repo := NewRepository(db)

	// accepted friendship me<->friend
	_, err := repo.Create(context.Background(), Friendship{RequesterID: me, AddresseeID: friend, Status: FriendStatusAccepted})
	require.NoError(t, err)
	// incoming pending requester->me
	_, err = repo.Create(context.Background(), Friendship{RequesterID: requester, AddresseeID: me, Status: FriendStatusPending})
	require.NoError(t, err)

	accepted, err := repo.ListAccepted(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, accepted, 1)
	require.Equal(t, "Friend", accepted[0].DisplayName)

	incoming, outgoing, err := repo.ListPending(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, incoming, 1)
	require.Equal(t, "Requester", incoming[0].User.DisplayName)
	require.Len(t, outgoing, 0)
}

func TestUpdateStatusAndDelete(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	repo := NewRepository(db)
	f, err := repo.Create(context.Background(), Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)

	require.NoError(t, repo.UpdateStatus(context.Background(), f.ID, FriendStatusAccepted))
	got, err := repo.FindByID(context.Background(), f.ID)
	require.NoError(t, err)
	require.Equal(t, FriendStatusAccepted, got.Status)

	require.NoError(t, repo.Delete(context.Background(), f.ID))
	gone, err := repo.FindByID(context.Background(), f.ID)
	require.NoError(t, err)
	require.Nil(t, gone)
}

func TestUserLookupsAndFriendCode(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db, "Coded")
	ur := user.NewRepository(db)

	u, err := ur.FindByEmail(context.Background(), "so-"+id.String()+"@test.dev")
	require.NoError(t, err)
	require.Equal(t, id, u.ID)

	require.NoError(t, ur.SetFriendCode(context.Background(), id, "ABC123XY"))
	byCode, err := ur.FindByCode(context.Background(), "ABC123XY")
	require.NoError(t, err)
	require.Equal(t, id, byCode.ID)
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/...`
Expected: FAIL/BUILD ERROR — `NewRepository` and methods undefined.

- [ ] **Step 7: Write the repository implementation.**

`api/internal/social/repository.go`:

```go
package social

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, f Friendship) (Friendship, error) {
	if err := r.db.WithContext(ctx).Create(&f).Error; err != nil {
		return Friendship{}, fmt.Errorf("social: create: %w", err)
	}
	return f, nil
}

// FindByPair returns the friendship between a and b in either direction, or
// (nil, nil) when none exists.
func (r Repository) FindByPair(ctx context.Context, a, b uuid.UUID) (*Friendship, error) {
	var f Friendship
	err := r.db.WithContext(ctx).
		Where("(requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)", a, b, b, a).
		First(&f).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("social: find pair: %w", err)
	}
	return &f, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Friendship, error) {
	var f Friendship
	err := r.db.WithContext(ctx).First(&f, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("social: find by id: %w", err)
	}
	return &f, nil
}

// ListAccepted returns the other party of every accepted friendship for userID.
func (r Repository) ListAccepted(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	views := []FriendView{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("u.id AS id, u.display_name AS display_name").
		Joins("JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END", userID).
		Where("f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)", FriendStatusAccepted, userID, userID).
		Order("u.display_name ASC").
		Scan(&views).Error
	if err != nil {
		return nil, fmt.Errorf("social: list accepted: %w", err)
	}
	return views, nil
}

// reqRow is a flat scan target; mapped into RequestView below.
type reqRow struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	DisplayName string
}

func (r Repository) listRequests(ctx context.Context, whereCol string, userID uuid.UUID, joinCol string) ([]RequestView, error) {
	rows := []reqRow{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("f.id AS id, u.id AS user_id, u.display_name AS display_name").
		Joins("JOIN users u ON u.id = f."+joinCol).
		Where("f.status = ? AND f."+whereCol+" = ?", FriendStatusPending, userID).
		Order("f.created_at DESC").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("social: list requests: %w", err)
	}
	out := make([]RequestView, 0, len(rows))
	for _, row := range rows {
		out = append(out, RequestView{ID: row.ID, User: FriendView{ID: row.UserID, DisplayName: row.DisplayName}})
	}
	return out, nil
}

// ListPending returns incoming (addressee=userID, other=requester) and
// outgoing (requester=userID, other=addressee) pending requests.
func (r Repository) ListPending(ctx context.Context, userID uuid.UUID) (incoming, outgoing []RequestView, err error) {
	incoming, err = r.listRequests(ctx, "addressee_id", userID, "requester_id")
	if err != nil {
		return nil, nil, err
	}
	outgoing, err = r.listRequests(ctx, "requester_id", userID, "addressee_id")
	if err != nil {
		return nil, nil, err
	}
	return incoming, outgoing, nil
}

func (r Repository) UpdateStatus(ctx context.Context, id uuid.UUID, status FriendStatus) error {
	if err := r.db.WithContext(ctx).Model(&Friendship{}).Where("id = ?", id).
		Updates(map[string]any{"status": status, "updated_at": gorm.Expr("now()")}).Error; err != nil {
		return fmt.Errorf("social: update status: %w", err)
	}
	return nil
}

func (r Repository) Delete(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Friendship{}, "id = ?", id).Error; err != nil {
		return fmt.Errorf("social: delete: %w", err)
	}
	return nil
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/... ./internal/user/...`
Expected: PASS. Also `go build ./...` clean.

- [ ] **Step 9: Commit**

```bash
git add api/internal/database/migrations/000009_friendships.up.sql api/internal/database/migrations/000009_friendships.down.sql api/internal/social/model.go api/internal/social/repository.go api/internal/social/repository_test.go api/internal/user/model.go api/internal/user/repository.go
git commit -m "feat(social): friendships table + model + repository"
```

---

### Task 2: `social` service (request/accept/decline/unfriend/code)

**Files:**
- Create: `api/internal/social/service.go`
- Create: `api/internal/social/errors.go`
- Test: `api/internal/social/service_test.go`

**Interfaces:**
- Consumes: `social.Repository` (Task 1), `user.Repository` (Task 1 methods).
- Produces (consumed by Task 3):
  - `social.NewService(repo Repository, users user.Repository) Service`
  - `Service.SendRequest(ctx, requesterID uuid.UUID, email, code string) (Friendship, error)`
  - `Service.Accept(ctx, addresseeID, requestID uuid.UUID) error`
  - `Service.Decline(ctx, addresseeID, requestID uuid.UUID) error`
  - `Service.Unfriend(ctx, userID, otherID uuid.UUID) error`
  - `Service.ListFriends(ctx, userID) ([]FriendView, error)`
  - `Service.ListRequests(ctx, userID) (incoming, outgoing []RequestView, error)`
  - `Service.MyCode(ctx, userID uuid.UUID) (code, link string, err error)`
  - Sentinel errors: `ErrBadInput`, `ErrUserNotFound`, `ErrSelfFriend`, `ErrNotFound`, `ErrForbidden`

- [ ] **Step 1: Write the sentinel errors.**

`api/internal/social/errors.go`:

```go
package social

import "errors"

var (
	ErrBadInput     = errors.New("provide exactly one of email or code")
	ErrUserNotFound = errors.New("no matching Kora account")
	ErrSelfFriend   = errors.New("cannot friend yourself")
	ErrNotFound     = errors.New("friendship not found")
	ErrForbidden    = errors.New("not allowed")
)
```

- [ ] **Step 2: Write the failing service test.**

`api/internal/social/service_test.go` (reuses `testDB`/`seedUser` from `repository_test.go` in the same package):

```go
package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

func TestSendRequestRejectsSelfAndMissing(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	svc := NewService(NewRepository(db), user.NewRepository(db))

	// self by email
	selfEmail := "so-" + me.String() + "@test.dev"
	_, err := svc.SendRequest(context.Background(), me, selfEmail, "")
	require.ErrorIs(t, err, ErrSelfFriend)

	// unknown email
	_, err = svc.SendRequest(context.Background(), me, "nobody@nowhere.dev", "")
	require.ErrorIs(t, err, ErrUserNotFound)

	// both provided
	_, err = svc.SendRequest(context.Background(), me, selfEmail, "CODE")
	require.ErrorIs(t, err, ErrBadInput)
}

func TestSendRequestCreatesPendingThenReversePendingAutoAccepts(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	bEmail := "so-" + b.String() + "@test.dev"
	aEmail := "so-" + a.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)

	// same-direction again is idempotent (still pending)
	f2, err := svc.SendRequest(context.Background(), a, bEmail, "")
	require.NoError(t, err)
	require.Equal(t, f.ID, f2.ID)

	// b requests a -> reverse pending -> auto-accept
	f3, err := svc.SendRequest(context.Background(), b, aEmail, "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusAccepted, f3.Status)

	friends, err := svc.ListFriends(context.Background(), a)
	require.NoError(t, err)
	require.Len(t, friends, 1)
	require.Equal(t, "Ben", friends[0].DisplayName)
}

func TestAcceptDeclineAuthorizationAndUnfriend(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	c := seedUser(t, db, "Cy")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	bEmail := "so-" + b.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "") // a->b pending
	require.NoError(t, err)

	// c (not the addressee) cannot accept
	require.ErrorIs(t, svc.Accept(context.Background(), c, f.ID), ErrForbidden)
	// b (addressee) accepts
	require.NoError(t, svc.Accept(context.Background(), b, f.ID))

	// unfriend removes it
	require.NoError(t, svc.Unfriend(context.Background(), a, b))
	friends, err := svc.ListFriends(context.Background(), a)
	require.NoError(t, err)
	require.Len(t, friends, 0)
}

func TestMyCodeIsStable(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	code1, link, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.NotEmpty(t, code1)
	require.Equal(t, "mobile://friend/"+code1, link)
	code2, _, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.Equal(t, code1, code2) // stable across calls
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/...`
Expected: BUILD ERROR — `NewService` / methods undefined.

- [ ] **Step 4: Write the service implementation.**

`api/internal/social/service.go`:

```go
package social

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

type Service struct {
	repo  Repository
	users user.Repository
}

func NewService(repo Repository, users user.Repository) Service {
	return Service{repo: repo, users: users}
}

// Crockford base32 alphabet (no I, L, O, U to avoid ambiguity).
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func generateCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b), nil
}

func (s Service) SendRequest(ctx context.Context, requesterID uuid.UUID, email, code string) (Friendship, error) {
	var target user.User
	var err error
	switch {
	case email != "" && code == "":
		target, err = s.users.FindByEmail(ctx, email)
	case code != "" && email == "":
		target, err = s.users.FindByCode(ctx, code)
	default:
		return Friendship{}, ErrBadInput
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Friendship{}, ErrUserNotFound
	}
	if err != nil {
		return Friendship{}, err
	}
	if target.ID == requesterID {
		return Friendship{}, ErrSelfFriend
	}

	existing, err := s.repo.FindByPair(ctx, requesterID, target.ID)
	if err != nil {
		return Friendship{}, err
	}
	if existing != nil {
		if existing.Status == FriendStatusPending && existing.AddresseeID == requesterID {
			// a reverse pending request exists → accept it
			if err := s.repo.UpdateStatus(ctx, existing.ID, FriendStatusAccepted); err != nil {
				return Friendship{}, err
			}
			existing.Status = FriendStatusAccepted
		}
		return *existing, nil // accepted or same-direction pending → idempotent
	}
	return s.repo.Create(ctx, Friendship{RequesterID: requesterID, AddresseeID: target.ID, Status: FriendStatusPending})
}

func (s Service) Accept(ctx context.Context, addresseeID, requestID uuid.UUID) error {
	f, err := s.repo.FindByID(ctx, requestID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusPending {
		return ErrNotFound
	}
	if f.AddresseeID != addresseeID {
		return ErrForbidden
	}
	return s.repo.UpdateStatus(ctx, f.ID, FriendStatusAccepted)
}

func (s Service) Decline(ctx context.Context, addresseeID, requestID uuid.UUID) error {
	f, err := s.repo.FindByID(ctx, requestID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusPending {
		return ErrNotFound
	}
	if f.AddresseeID != addresseeID {
		return ErrForbidden
	}
	return s.repo.Delete(ctx, f.ID)
}

func (s Service) Unfriend(ctx context.Context, userID, otherID uuid.UUID) error {
	f, err := s.repo.FindByPair(ctx, userID, otherID)
	if err != nil {
		return err
	}
	if f == nil || f.Status != FriendStatusAccepted {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, f.ID)
}

func (s Service) ListFriends(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	return s.repo.ListAccepted(ctx, userID)
}

func (s Service) ListRequests(ctx context.Context, userID uuid.UUID) (incoming, outgoing []RequestView, err error) {
	return s.repo.ListPending(ctx, userID)
}

func (s Service) MyCode(ctx context.Context, userID uuid.UUID) (string, string, error) {
	u, err := s.users.ByID(ctx, userID)
	if err != nil {
		return "", "", err
	}
	if u.FriendCode == "" {
		code, err := generateCode()
		if err != nil {
			return "", "", err
		}
		if err := s.users.SetFriendCode(ctx, userID, code); err != nil {
			return "", "", err
		}
		u.FriendCode = code
	}
	return u.FriendCode, "mobile://friend/" + u.FriendCode, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/...`
Expected: PASS. `go build ./...` clean.

- [ ] **Step 6: Commit**

```bash
git add api/internal/social/service.go api/internal/social/errors.go api/internal/social/service_test.go
git commit -m "feat(social): friendship service with request/accept/decline/unfriend/code"
```

---

### Task 3: HTTP handlers + routes

**Files:**
- Create: `api/internal/social/handler.go`
- Modify: `api/internal/server/router.go` (wire the social routes)
- Test: `api/internal/social/handler_test.go`

**Interfaces:**
- Consumes: `social.Service` (Task 2), `httpx`, `user.IDFromContext`.
- Produces: `social.NewHandler(svc Service) Handler` with methods `ListFriends`, `ListRequests`, `SendRequest`, `Accept`, `Decline`, `Unfriend`, `Code`; routes mounted under `/v1`.

- [ ] **Step 1: Write the failing handler test.**

`api/internal/social/handler_test.go` (reuses `testDB`/`seedUser` from `repository_test.go`; `mountFor` seeds and mounts against one shared DB handle to avoid a chicken-and-egg between seeding and routing):

```go
package social

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

func mountFor(callerID uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", callerID); c.Next() })
	h := NewHandler(NewService(NewRepository(db), user.NewRepository(db)))
	r.GET("/v1/friends", h.ListFriends)
	r.GET("/v1/friends/requests", h.ListRequests)
	r.POST("/v1/friends/requests", h.SendRequest)
	r.POST("/v1/friends/requests/:id/accept", h.Accept)
	r.POST("/v1/friends/requests/:id/decline", h.Decline)
	r.DELETE("/v1/friends/:userId", h.Unfriend)
	r.GET("/v1/friends/code", h.Code)
	return r
}

func doPOST(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestSendRequestStatusCodes(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	other := seedUser(t, db, "Other")
	r := mountFor(me, db)
	otherEmail := "so-" + other.String() + "@test.dev"

	// both fields -> 400
	require.Equal(t, http.StatusBadRequest, doPOST(r, "/v1/friends/requests", `{"email":"x@y.z","code":"C"}`).Code)
	// unknown -> 404
	require.Equal(t, http.StatusNotFound, doPOST(r, "/v1/friends/requests", `{"email":"nobody@nowhere.dev"}`).Code)
	// self -> 409
	selfEmail := "so-" + me.String() + "@test.dev"
	require.Equal(t, http.StatusConflict, doPOST(r, "/v1/friends/requests", `{"email":"`+selfEmail+`"}`).Code)
	// valid -> 201
	require.Equal(t, http.StatusCreated, doPOST(r, "/v1/friends/requests", `{"email":"`+otherEmail+`"}`).Code)
}

func TestAcceptForbiddenForNonAddressee(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	c := seedUser(t, db, "Cy")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	f, err := svc.SendRequest(context.Background(), a, "so-"+b.String()+"@test.dev", "")
	require.NoError(t, err)

	// c tries to accept a->b request -> 403
	rc := mountFor(c, db)
	require.Equal(t, http.StatusForbidden, doPOST(rc, "/v1/friends/requests/"+f.ID.String()+"/accept", "").Code)
	// b accepts -> 200
	rb := mountFor(b, db)
	require.Equal(t, http.StatusOK, doPOST(rb, "/v1/friends/requests/"+f.ID.String()+"/accept", "").Code)
}

func TestListFriendsAndCodeShape(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)

	req := httptest.NewRequest(http.MethodGet, "/v1/friends/code", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Code string `json:"code"`
			Link string `json:"link"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Code)
	require.Equal(t, "mobile://friend/"+body.Data.Code, body.Data.Link)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./internal/social/...`
Expected: BUILD ERROR — `NewHandler` undefined.

- [ ] **Step 3: Write the handler.**

`api/internal/social/handler.go`:

```go
package social

import (
	"errors"
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

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func mapErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrBadInput):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "provide exactly one of email or code")
	case errors.Is(err, ErrUserNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "no Kora account matches that email or code")
	case errors.Is(err, ErrSelfFriend):
		httpx.Error(c, http.StatusConflict, "conflict", "you can't add yourself")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

func (h Handler) ListFriends(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	views, err := h.svc.ListFriends(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, views)
}

func (h Handler) ListRequests(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	incoming, outgoing, err := h.svc.ListRequests(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"incoming": incoming, "outgoing": outgoing})
}

type sendRequestBody struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

func (h Handler) SendRequest(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req sendRequestBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	f, err := h.svc.SendRequest(c.Request.Context(), uid, req.Email, req.Code)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": f})
}

func (h Handler) Accept(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request id")
		return
	}
	if err := h.svc.Accept(c.Request.Context(), uid, id); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"accepted": true})
}

func (h Handler) Decline(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request id")
		return
	}
	if err := h.svc.Decline(c.Request.Context(), uid, id); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"declined": true})
}

func (h Handler) Unfriend(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	other, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid user id")
		return
	}
	if err := h.svc.Unfriend(c.Request.Context(), uid, other); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"removed": true})
}

func (h Handler) Code(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	code, link, err := h.svc.MyCode(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"code": code, "link": link})
}
```

- [ ] **Step 4: Wire routes in `api/internal/server/router.go`.**

Add `"github.com/tesserix/kora/api/internal/social"` to the imports. After the tracking block (right before the `dashboardHandler` block), add:

```go
		socialHandler := social.NewHandler(social.NewService(social.NewRepository(deps.DB), userRepo))
		v1.GET("/friends", socialHandler.ListFriends)
		v1.GET("/friends/requests", socialHandler.ListRequests)
		v1.POST("/friends/requests", socialHandler.SendRequest)
		v1.POST("/friends/requests/:id/accept", socialHandler.Accept)
		v1.POST("/friends/requests/:id/decline", socialHandler.Decline)
		v1.DELETE("/friends/:userId", socialHandler.Unfriend)
		v1.GET("/friends/code", socialHandler.Code)
```

- [ ] **Step 5: Run the tests + build to verify they pass**

Run (from `api/`): `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./... && go build ./...`
Expected: PASS and clean build (confirms the `/friends/requests` static vs `/friends/:userId` param routes coexist without a gin panic — they do, since they never collide within one HTTP method).

- [ ] **Step 6: Commit**

```bash
git add api/internal/social/handler.go api/internal/social/handler_test.go api/internal/server/router.go
git commit -m "feat(social): friends HTTP handlers + routes"
```

---

### Task 4: Mobile types + hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (add social types)
- Modify: `apps/mobile/src/api/hooks.ts` (add seven hooks)
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces:**
- Produces (consumed by Task 5):
  - Types `Friend`, `FriendRequest`, `FriendRequests`, `MyFriendCode`.
  - `useFriends()`, `useFriendRequests()`, `useSendFriendRequest()` (`mutate({email?:string; code?:string})`), `useAcceptRequest()` (`mutate(id)`), `useDeclineRequest()` (`mutate(id)`), `useUnfriend()` (`mutate(userId)`), `useMyFriendCode()`.

- [ ] **Step 1: Write the failing tests.** Append to `apps/mobile/src/api/__tests__/hooks.test.tsx` and add the new hook names to the import from `"../hooks"`:

```tsx
test("useSendFriendRequest POSTs the body to /v1/friends/requests", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "f1", status: "pending" });
  const { result } = await renderHook(() => useSendFriendRequest(), { wrapper });
  result.current.mutate({ code: "ABC123XY" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/requests", {
    method: "POST",
    body: JSON.stringify({ code: "ABC123XY" }),
  });
});

test("useAcceptRequest POSTs /v1/friends/requests/:id/accept", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ accepted: true });
  const { result } = await renderHook(() => useAcceptRequest(), { wrapper });
  result.current.mutate("req1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/requests/req1/accept", { method: "POST" });
});

test("useUnfriend DELETEs /v1/friends/:userId", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ removed: true });
  const { result } = await renderHook(() => useUnfriend(), { wrapper });
  result.current.mutate("u9");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/friends/u9", { method: "DELETE" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/mobile/`): `npm test -- --ci hooks.test`
Expected: FAIL — hooks not exported.

- [ ] **Step 3: Add the types.** In `apps/mobile/src/api/types.ts`, add:

```ts
export interface Friend {
  id: string;
  display_name: string;
}

export interface FriendRequest {
  id: string;
  user: Friend;
}

export interface FriendRequests {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export interface MyFriendCode {
  code: string;
  link: string;
}
```

- [ ] **Step 4: Add the hooks.** In `apps/mobile/src/api/hooks.ts`, add `Friend`, `FriendRequests`, `MyFriendCode` to the type import from `"./types"`, then append:

```ts
export function useFriends() {
  return useQuery({
    queryKey: ["friends"],
    queryFn: () => apiFetch("/v1/friends") as Promise<Friend[]>,
  });
}

export function useFriendRequests() {
  return useQuery({
    queryKey: ["friend-requests"],
    queryFn: () => apiFetch("/v1/friends/requests") as Promise<FriendRequests>,
  });
}

export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email?: string; code?: string }) =>
      apiFetch("/v1/friends/requests", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/accept`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["friend-requests"] });
      qc.invalidateQueries({ queryKey: ["friends"] });
    },
  });
}

export function useDeclineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/v1/friends/requests/${id}/decline`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friend-requests"] }),
  });
}

export function useUnfriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiFetch(`/v1/friends/${userId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["friends"] }),
  });
}

export function useMyFriendCode() {
  return useQuery({
    queryKey: ["friend-code"],
    queryFn: () => apiFetch("/v1/friends/code") as Promise<MyFriendCode>,
  });
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run (from `apps/mobile/`): `npm test -- --ci hooks.test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): friends types + query hooks"
```

---

### Task 5: Friends screen + AddFriendSheet + `users` glyph

**Files:**
- Create: `apps/mobile/app/friends.tsx`
- Create: `apps/mobile/src/components/social/AddFriendSheet.tsx`
- Modify: `apps/mobile/src/components/Icon.tsx` (register `users`)
- Test: `apps/mobile/app/__tests__/friends.test.tsx`
- Test: `apps/mobile/src/components/social/__tests__/AddFriendSheet.test.tsx`

**Interfaces:**
- Consumes: the Task 4 hooks; shared `Sheet`, `AppText`, `Overline`, `Button`, `Icon`, `useTheme`.
- Produces: a `/friends` route (default export) and `AddFriendSheet({ visible, onClose })`.

- [ ] **Step 1: Register the `users` glyph.** In `apps/mobile/src/components/Icon.tsx`, add `Users` to the lucide import and `users: Users` to `MAP`.

- [ ] **Step 2: Write the failing AddFriendSheet test.** `apps/mobile/src/components/social/__tests__/AddFriendSheet.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { AddFriendSheet } from "../AddFriendSheet";

const mockSendMutate = jest.fn();
jest.mock("@/api/hooks", () => ({
  useSendFriendRequest: () => ({ mutate: mockSendMutate, isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
}));
beforeEach(() => mockSendMutate.mockClear());

test("submitting sends the entered code as the request body", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  await fireEvent.changeText(getByLabelText("Friend code or email"), "XYZ789AB");
  await fireEvent.press(getByText("Send request"));
  expect(mockSendMutate).toHaveBeenCalledWith(
    { code: "XYZ789AB" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("an input containing @ is sent as email", async () => {
  const { getByLabelText, getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  await fireEvent.changeText(getByLabelText("Friend code or email"), "pal@kora.app");
  await fireEvent.press(getByText("Send request"));
  expect(mockSendMutate).toHaveBeenCalledWith(
    { email: "pal@kora.app" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("shows my share code", async () => {
  const { getByText } = await render(<AddFriendSheet visible onClose={jest.fn()} />);
  expect(getByText("ABC123XY")).toBeTruthy();
});
```

- [ ] **Step 3: Run to verify it fails**

Run (from `apps/mobile/`): `npm test -- --ci AddFriendSheet`
Expected: FAIL — `../AddFriendSheet` missing.

- [ ] **Step 4: Write `AddFriendSheet`.** `apps/mobile/src/components/social/AddFriendSheet.tsx`:

```tsx
import { useState } from "react";
import { Share, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useSendFriendRequest, useMyFriendCode } from "@/api/hooks";
import { useTheme } from "@/theme";

interface AddFriendSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function AddFriendSheet({ visible, onClose }: AddFriendSheetProps) {
  const { colors, fonts, radius } = useTheme();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = useSendFriendRequest();
  const myCode = useMyFriendCode();

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr("Enter a friend code or email.");
      return;
    }
    setErr(null);
    const input = v.includes("@") ? { email: v } : { code: v };
    send.mutate(input, {
      onSuccess: () => {
        setValue("");
        onClose();
      },
      onError: () => setErr("No Kora account matches that code or email."),
    });
  };

  const shareCode = () => {
    if (myCode.data) Share.share({ message: myCode.data.link });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Add a friend</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Friend code or email"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Friend code or email"
          style={{ marginTop: 12, fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title="Send request" onPress={onSubmit} disabled={send.isPending} style={{ marginTop: 14 }} />

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 22 }} />

        <Overline>Your code</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
          <AppText style={{ fontSize: 20, fontFamily: fonts.mono, letterSpacing: 2 }}>
            {myCode.data?.code ?? "········"}
          </AppText>
          <Button title="Share" onPress={shareCode} variant="ghost" disabled={!myCode.data} />
        </View>
      </View>
    </Sheet>
  );
}
```

(`Button`'s variants are `"primary" | "secondary" | "ghost"` — `"ghost"` is the transparent/outline style used here.)

- [ ] **Step 5: Run to verify it passes**

Run (from `apps/mobile/`): `npm test -- --ci AddFriendSheet && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Write the failing Friends screen test.** `apps/mobile/app/__tests__/friends.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";

const mockAcceptMutate = jest.fn();
const mockDeclineMutate = jest.fn();
const mockUnfriendMutate = jest.fn();

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useFriends: () => ({ data: [{ id: "u1", display_name: "Ada" }] }),
  useFriendRequests: () => ({ data: { incoming: [{ id: "r1", user: { id: "u2", display_name: "Ben" } }], outgoing: [] } }),
  useAcceptRequest: () => ({ mutate: mockAcceptMutate, isPending: false }),
  useDeclineRequest: () => ({ mutate: mockDeclineMutate, isPending: false }),
  useUnfriend: () => ({ mutate: mockUnfriendMutate, isPending: false }),
  useSendFriendRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
}));

import Friends from "../friends";

beforeEach(() => { mockAcceptMutate.mockClear(); mockDeclineMutate.mockClear(); });

test("renders friends and incoming requests; Accept calls the hook with the request id", async () => {
  const { getByText, getByLabelText } = await render(<Friends />);
  expect(getByText("Ada")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
  await fireEvent.press(getByLabelText("Accept request from Ben"));
  expect(mockAcceptMutate).toHaveBeenCalledWith("r1");
});
```

- [ ] **Step 7: Run to verify it fails**

Run (from `apps/mobile/`): `npm test -- --ci friends.test`
Expected: FAIL — `../friends` missing.

- [ ] **Step 8: Write the Friends screen.** `apps/mobile/app/friends.tsx`:

```tsx
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { AddFriendSheet } from "@/components/social/AddFriendSheet";
import { useFriends, useFriendRequests, useAcceptRequest, useDeclineRequest, useUnfriend } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function Friends() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const friends = useFriends();
  const requests = useFriendRequests();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();
  const unfriend = useUnfriend();
  const [addOpen, setAddOpen] = useState(false);

  const incoming = requests.data?.incoming ?? [];
  const list = friends.data ?? [];

  const onUnfriend = (id: string, name: string) =>
    Alert.alert("Remove friend?", `Remove ${name} from your friends.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => unfriend.mutate(id) },
    ]);

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your circle" title="Friends" />
        <View style={{ paddingHorizontal: 20, gap: 20 }}>
          <Button title="Add a friend" onPress={() => setAddOpen(true)} />

          {incoming.length > 0 ? (
            <View style={{ gap: 10 }}>
              <Overline>Requests</Overline>
              {incoming.map((r) => (
                <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                  <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600" }}>{r.user.display_name}</AppText>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Accept request from ${r.user.display_name}`} onPress={() => accept.mutate(r.id)} style={{ width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary }}>
                    <Icon name="check" size={18} color={colors.primaryForeground} />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Decline request from ${r.user.display_name}`} onPress={() => decline.mutate(r.id)} style={{ width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border }}>
                    <Icon name="x" size={18} color={colors.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <Overline>Friends</Overline>
            {list.length === 0 ? (
              <AppText muted>No friends yet. Share your code to connect.</AppText>
            ) : (
              list.map((f) => (
                <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={`Remove ${f.display_name}`} onLongPress={() => onUnfriend(f.id, f.display_name)} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                  <Icon name="users" size={18} color={colors.primary} />
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{f.display_name}</AppText>
                </Pressable>
              ))
            )}
          </View>
        </View>
      </ScrollView>
      <AddFriendSheet visible={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
```

- [ ] **Step 9: Run to verify it passes + full suite + typecheck**

Run (from `apps/mobile/`): `npm test -- --ci friends.test AddFriendSheet && npx tsc --noEmit && npm test -- --ci`
Expected: PASS; whole suite green.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/app/friends.tsx apps/mobile/src/components/social/AddFriendSheet.tsx apps/mobile/src/components/Icon.tsx apps/mobile/app/__tests__/friends.test.tsx apps/mobile/src/components/social/__tests__/AddFriendSheet.test.tsx
git commit -m "feat(mobile): Friends screen + AddFriendSheet"
```

---

### Task 6: More-tab "Friends" row wiring

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`
- Test: `apps/mobile/app/(tabs)/__tests__/more.test.tsx` (create if absent)

**Interfaces:**
- Consumes: the `/friends` route (Task 5), `expo-router` `router.push`.

- [ ] **Step 1: Write the failing test.** `apps/mobile/app/(tabs)/__tests__/more.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/lib/firebase", () => ({ auth: null }));
jest.mock("firebase/auth", () => ({ signOut: jest.fn() }));

import More from "../more";

beforeEach(() => mockPush.mockClear());

test("tapping Friends navigates to /friends", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Friends"));
  expect(mockPush).toHaveBeenCalledWith("/friends");
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/mobile/`): `npm test -- --ci more.test`
Expected: FAIL — no "Friends" row / not pressable.

- [ ] **Step 3: Wire the row.** In `apps/mobile/app/(tabs)/more.tsx`:

Add `import { router } from "expo-router";` at the top.

Add a `users` row to the `ROWS` array as the first entry, and give it a route:

```tsx
const ROWS = [
  { icon: "users", label: "Friends", route: "/friends" },
  { icon: "message-circle", label: "Coach" },
  { icon: "trending-up", label: "Insights" },
  { icon: "grid-2x2", label: "Add-ons" },
];
```

Replace the row-rendering `View` with a `Pressable` that navigates when the row has a `route`:

```tsx
        {ROWS.map((r) => (
          <Pressable
            key={r.label}
            accessibilityRole="button"
            onPress={() => r.route && router.push(r.route)}
            style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
          >
            <Icon name={r.icon} size={20} color={colors.primary} />
            <AppText style={{ fontSize: 15, fontWeight: "600" }}>{r.label}</AppText>
          </Pressable>
        ))}
```

(`Pressable` is already imported in `more.tsx`.)

- [ ] **Step 4: Run to verify it passes + full suite + typecheck**

Run (from `apps/mobile/`): `npm test -- --ci more.test && npx tsc --noEmit && npm test -- --ci`
Expected: PASS; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/\(tabs\)/more.tsx apps/mobile/app/\(tabs\)/__tests__/more.test.tsx
git commit -m "feat(mobile): Friends row in the More tab"
```

---

## Final verification (after all tasks)

- [ ] Backend: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./... && go build ./...` — all green.
- [ ] Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` — all green.
- [ ] Final whole-branch review of the feature commits on the most capable model before declaring READY TO MERGE.
- [ ] Do NOT push until the user approves. Decide the PR base (`phase-4-social` → which base) with the user.

## Notes for implementers
- Stale RED LSP diagnostics after a test-before-impl step are normal on Go — verify with `go build ./...` / `go test`, not the editor.
- `Button` variants are `"primary" | "secondary" | "ghost"` (see `apps/mobile/src/components/Button.tsx`); the Share button uses `"ghost"`.
