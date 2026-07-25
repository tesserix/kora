# Groups (Social C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create/join groups (via invite code or owner-invites-friend), manage membership (owner-admin), and see a shared-progress leaderboard scoped to each group — reusing B's metric computation and consent gate.

**Architecture:** New `internal/groups` package (`groups`/`group_members` tables, migration `000011`) mirroring `social`. The `compare` package is generalized so a single consent-gated `ProgressForMembers` path serves both friends and group leaderboards. Mobile adds a groups list + create/join and a group-detail screen (roster + leaderboard + owner controls).

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate (Postgres); React Native / Expo (SDK 57), expo-router, TanStack Query v5, Jest + RNTL v14, TypeScript.

## Global Constraints

- Backend DB tests vs `kora_test`: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go test -race -p 1 -count=1 ./...`. Tests FOREGROUND.
- After adding migration files, apply to `kora_test` first: from `api/`, `TEST_DATABASE_URL=…/kora_test?sslmode=disable go run ./cmd/migrate`.
- Stale RED LSP diagnostics after a test-before-impl step are normal on Go — verify with `go build ./...` / `go test`.
- Handlers resolve the caller via `user.IDFromContext(c)` (context key `user_id`); day/tz = `time.Now()` + `user.LocFromContext(c)`.
- Envelope: `httpx.OK(c,data)` → `{"data":…}`; `httpx.Error(c,status,code,msg)` → `{"error":code,"message":msg}`. No internal detail leaked.
- **Consent gate stays in ONE place** (`compare.ProgressForMembers`) — a non-sharing member's metrics must never be computed/serialized.
- Mobile: `npx tsc --noEmit` + `npm test -- --ci` stay green (currently 166/166). Jest `jest.mock` factories reference only `mock`-prefixed vars.
- Conventional single-line commits, no signature. No pushing until the user approves.

---

### Task 1: Migration `000011` + `groups` models + repository

**Files:**
- Create: `api/internal/database/migrations/000011_groups.up.sql`, `…down.sql`
- Create: `api/internal/groups/model.go`, `api/internal/groups/repository.go`
- Test: `api/internal/groups/repository_test.go`

**Interfaces (produced, consumed by Task 2):**
- `groups.Role` (`RoleOwner`,`RoleMember`); `groups.Group`, `groups.GroupMember`; views `GroupSummary{ID,Name,MemberCount,Role}`, `MemberView{ID,DisplayName,Role}`, `MemberProgressRow{ID,DisplayName,ShareProgress,TargetKcal}`.
- `groups.Repository`: `CreateGroup(ctx,ownerID,name,code)(Group,error)` (tx: group + owner member), `FindByID(ctx,id)(*Group,error)`, `FindByInviteCode(ctx,code)(*Group,error)`, `ListForUser(ctx,userID)([]GroupSummary,error)`, `AddMember(ctx,groupID,userID,Role)error` (idempotent), `RemoveMember(ctx,groupID,userID)error`, `IsMember(ctx,groupID,userID)(bool,error)`, `RoleOf(ctx,groupID,userID)(Role,bool,error)`, `ListMembers(ctx,groupID)([]MemberView,error)`, `ListMembersForProgress(ctx,groupID)([]MemberProgressRow,error)`, `Rename(ctx,groupID,name)error`, `DeleteGroup(ctx,groupID)error`.

- [ ] **Step 1: Migration files.**

`000011_groups.up.sql`:
```sql
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE group_members (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX ix_group_members_user ON group_members (user_id);
```
`000011_groups.down.sql`:
```sql
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
```

- [ ] **Step 2: Apply to kora_test.** From `api/`: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5432/kora_test?sslmode=disable go run ./cmd/migrate` → exits 0, version 11 clean.

- [ ] **Step 3: Model.** `api/internal/groups/model.go`:
```go
// Package groups owns the group membership graph.
package groups

import (
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleMember Role = "member"
)

type Group struct {
	ID         uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name       string    `json:"name"`
	OwnerID    uuid.UUID `json:"owner_id"`
	InviteCode string    `json:"invite_code"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type GroupMember struct {
	GroupID  uuid.UUID `gorm:"primaryKey" json:"group_id"`
	UserID   uuid.UUID `gorm:"primaryKey" json:"user_id"`
	Role     Role      `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

type GroupSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	MemberCount int       `json:"member_count"`
	Role        Role      `json:"role"`
}

type MemberView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
}

// MemberProgressRow feeds the group leaderboard (mapped to compare.Member in the handler).
type MemberProgressRow struct {
	ID            uuid.UUID
	DisplayName   string
	ShareProgress bool
	TargetKcal    float64
}
```

- [ ] **Step 4: Write the failing repository test.** `api/internal/groups/repository_test.go`:
```go
package groups

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
		id, "gr-"+id.String(), "gr-"+id.String()+"@test.dev", name).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM group_members WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestCreateGroupAutoJoinsOwnerAndLists(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	repo := NewRepository(db)
	g, err := repo.CreateGroup(context.Background(), owner, "Squad", "CODE1234")
	require.NoError(t, err)
	require.NotEqual(t, uuid.Nil, g.ID)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	// owner is a member with role owner
	role, ok, err := repo.RoleOf(context.Background(), g.ID, owner)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, RoleOwner, role)

	// ListForUser shows it with member_count 1 and my role owner
	summaries, err := repo.ListForUser(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, summaries, 1)
	require.Equal(t, "Squad", summaries[0].Name)
	require.Equal(t, 1, summaries[0].MemberCount)
	require.Equal(t, RoleOwner, summaries[0].Role)
}

func TestJoinListMembersRemove(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	joiner := seedUser(t, db, "Joiner")
	repo := NewRepository(db)
	g, err := repo.CreateGroup(context.Background(), owner, "Squad", "CODE5678")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	found, err := repo.FindByInviteCode(context.Background(), "CODE5678")
	require.NoError(t, err)
	require.NotNil(t, found)
	require.Equal(t, g.ID, found.ID)

	require.NoError(t, repo.AddMember(context.Background(), g.ID, joiner, RoleMember))
	// idempotent
	require.NoError(t, repo.AddMember(context.Background(), g.ID, joiner, RoleMember))

	members, err := repo.ListMembers(context.Background(), g.ID)
	require.NoError(t, err)
	require.Len(t, members, 2)

	isMember, err := repo.IsMember(context.Background(), g.ID, joiner)
	require.NoError(t, err)
	require.True(t, isMember)

	require.NoError(t, repo.RemoveMember(context.Background(), g.ID, joiner))
	isMember, _ = repo.IsMember(context.Background(), g.ID, joiner)
	require.False(t, isMember)
}
```

- [ ] **Step 5: Run to verify fail** — `TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./internal/groups/...` → BUILD ERROR (NewRepository undefined).

- [ ] **Step 6: Write the repository.** `api/internal/groups/repository.go`:
```go
package groups

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

func (r Repository) CreateGroup(ctx context.Context, ownerID uuid.UUID, name, code string) (Group, error) {
	g := Group{Name: name, OwnerID: ownerID, InviteCode: code}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&g).Error; err != nil {
			return err
		}
		return tx.Create(&GroupMember{GroupID: g.ID, UserID: ownerID, Role: RoleOwner}).Error
	})
	if err != nil {
		return Group{}, fmt.Errorf("groups: create: %w", err)
	}
	return g, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Group, error) {
	var g Group
	err := r.db.WithContext(ctx).First(&g, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("groups: find by id: %w", err)
	}
	return &g, nil
}

func (r Repository) FindByInviteCode(ctx context.Context, code string) (*Group, error) {
	var g Group
	err := r.db.WithContext(ctx).Where("invite_code = ?", code).First(&g).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("groups: find by code: %w", err)
	}
	return &g, nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]GroupSummary, error) {
	out := []GroupSummary{}
	err := r.db.WithContext(ctx).
		Table("groups AS g").
		Select("g.id AS id, g.name AS name, gm.role AS role, (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS member_count").
		Joins("JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?", userID).
		Order("g.created_at DESC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list for user: %w", err)
	}
	return out, nil
}

func (r Repository) AddMember(ctx context.Context, groupID, userID uuid.UUID, role Role) error {
	m := GroupMember{GroupID: groupID, UserID: userID, Role: role}
	// idempotent: do nothing if the (group,user) row already exists
	err := r.db.WithContext(ctx).
		Clauses(clauseDoNothing()).
		Create(&m).Error
	if err != nil {
		return fmt.Errorf("groups: add member: %w", err)
	}
	return nil
}

func (r Repository) RemoveMember(ctx context.Context, groupID, userID uuid.UUID) error {
	if err := r.db.WithContext(ctx).
		Where("group_id = ? AND user_id = ?", groupID, userID).
		Delete(&GroupMember{}).Error; err != nil {
		return fmt.Errorf("groups: remove member: %w", err)
	}
	return nil
}

func (r Repository) IsMember(ctx context.Context, groupID, userID uuid.UUID) (bool, error) {
	var count int64
	if err := r.db.WithContext(ctx).Model(&GroupMember{}).
		Where("group_id = ? AND user_id = ?", groupID, userID).
		Count(&count).Error; err != nil {
		return false, fmt.Errorf("groups: is member: %w", err)
	}
	return count > 0, nil
}

func (r Repository) RoleOf(ctx context.Context, groupID, userID uuid.UUID) (Role, bool, error) {
	var m GroupMember
	err := r.db.WithContext(ctx).
		Where("group_id = ? AND user_id = ?", groupID, userID).First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("groups: role of: %w", err)
	}
	return m.Role, true, nil
}

func (r Repository) ListMembers(ctx context.Context, groupID uuid.UUID) ([]MemberView, error) {
	out := []MemberView{}
	err := r.db.WithContext(ctx).
		Table("group_members AS gm").
		Select("u.id AS id, u.display_name AS display_name, gm.role AS role").
		Joins("JOIN users u ON u.id = gm.user_id").
		Where("gm.group_id = ?", groupID).
		Order("gm.role ASC, u.display_name ASC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list members: %w", err)
	}
	return out, nil
}

func (r Repository) ListMembersForProgress(ctx context.Context, groupID uuid.UUID) ([]MemberProgressRow, error) {
	out := []MemberProgressRow{}
	err := r.db.WithContext(ctx).
		Table("group_members AS gm").
		Select("u.id AS id, u.display_name AS display_name, u.share_progress AS share_progress, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = gm.user_id").
		Where("gm.group_id = ?", groupID).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list members for progress: %w", err)
	}
	return out, nil
}

func (r Repository) Rename(ctx context.Context, groupID uuid.UUID, name string) error {
	if err := r.db.WithContext(ctx).Model(&Group{}).Where("id = ?", groupID).
		Updates(map[string]any{"name": name, "updated_at": gorm.Expr("now()")}).Error; err != nil {
		return fmt.Errorf("groups: rename: %w", err)
	}
	return nil
}

func (r Repository) DeleteGroup(ctx context.Context, groupID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Group{}, "id = ?", groupID).Error; err != nil {
		return fmt.Errorf("groups: delete: %w", err)
	}
	return nil
}
```
Add this helper at the bottom of the file (kept separate so the import stays tidy):
```go
import "gorm.io/gorm/clause"

func clauseDoNothing() clause.Expression {
	return clause.OnConflict{DoNothing: true}
}
```
(Merge that `import` into the file's existing import block — do not add a second `import` statement; the helper uses `clause.OnConflict{DoNothing:true}` so a duplicate `(group_id,user_id)` insert is a no-op.)

- [ ] **Step 7: Run to verify pass** — `TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./internal/groups/... && go build ./...` → PASS, clean.

- [ ] **Step 8: Commit**
```bash
git add api/internal/database/migrations/000011_groups.up.sql api/internal/database/migrations/000011_groups.down.sql api/internal/groups/model.go api/internal/groups/repository.go api/internal/groups/repository_test.go
git commit -m "feat(groups): groups + group_members tables, model, repository"
```

---

### Task 2: `groups` service + `social.AreFriends`

**Files:**
- Create: `api/internal/groups/service.go`, `api/internal/groups/errors.go`
- Modify: `api/internal/social/repository.go` (add `AreFriends`)
- Test: `api/internal/groups/service_test.go`, `api/internal/social/are_friends_test.go`

**Interfaces (produced):**
- `groups.NewService(repo Repository, friends friendChecker, codeGen func()(string,error)) Service` where `friendChecker interface{ AreFriends(ctx,a,b uuid.UUID)(bool,error) }`.
- Methods: `Create(ctx,ownerID,name)(Group,error)`, `JoinByCode(ctx,userID,code)(Group,error)`, `InviteFriend(ctx,ownerID,groupID,friendID)error`, `Leave(ctx,userID,groupID)error`, `RemoveMember(ctx,ownerID,groupID,memberID)error`, `Rename(ctx,ownerID,groupID,name)error`, `Delete(ctx,ownerID,groupID)error`, `ListGroups(ctx,userID)([]GroupSummary,error)`, `Detail(ctx,userID,groupID)(GroupDetail,error)`.
- `GroupDetail{ID,Name,InviteCode string,MyRole Role,Members []MemberView}`.
- Sentinel errors: `ErrNotFound`, `ErrForbidden`, `ErrBadInput`, `ErrOwnerCannotLeave`, `ErrNotFriends`.
- `social.Repository.AreFriends(ctx,a,b)(bool,error)`.

- [ ] **Step 1: `social.AreFriends` + its test.** Add to `api/internal/social/repository.go`:
```go
func (r Repository) AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error) {
	f, err := r.FindByPair(ctx, a, b)
	if err != nil {
		return false, err
	}
	return f != nil && f.Status == FriendStatusAccepted, nil
}
```
`api/internal/social/are_friends_test.go`:
```go
package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAreFriendsTrueOnlyWhenAccepted(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "A")
	b := seedUser(t, db, "B")
	repo := NewRepository(db)

	ok, err := repo.AreFriends(context.Background(), a, b)
	require.NoError(t, err)
	require.False(t, ok) // no relationship

	_, err = repo.Create(context.Background(), Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)
	ok, _ = repo.AreFriends(context.Background(), a, b)
	require.False(t, ok) // pending is not friends

	require.NoError(t, repo.UpdateStatus(context.Background(), mustPairID(t, repo, a, b), FriendStatusAccepted))
	ok, _ = repo.AreFriends(context.Background(), a, b)
	require.True(t, ok)
}

func mustPairID(t *testing.T, repo Repository, a, b [16]byte) [16]byte {
	f, err := repo.FindByPair(context.Background(), a, b)
	require.NoError(t, err)
	require.NotNil(t, f)
	return f.ID
}
```
(`[16]byte` is `uuid.UUID`'s underlying type; if the compiler prefers, import `"github.com/google/uuid"` and use `uuid.UUID` in `mustPairID`'s signature.)

- [ ] **Step 2: Errors.** `api/internal/groups/errors.go`:
```go
package groups

import "errors"

var (
	ErrNotFound         = errors.New("group not found")
	ErrForbidden        = errors.New("not allowed")
	ErrBadInput         = errors.New("invalid input")
	ErrOwnerCannotLeave = errors.New("owner cannot leave; delete the group instead")
	ErrNotFriends       = errors.New("can only invite an accepted friend")
)
```

- [ ] **Step 3: Write the failing service test.** `api/internal/groups/service_test.go` (one `db := testDB(t)` per test, seeded with the package's existing `seedUser`; a stub `friendChecker`; a sequencing code generator so invite codes never collide):
```go
package groups

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type stubFriends struct{ pairs map[[2]uuid.UUID]bool }

func (s stubFriends) AreFriends(_ context.Context, a, b uuid.UUID) (bool, error) {
	return s.pairs[[2]uuid.UUID{a, b}] || s.pairs[[2]uuid.UUID{b, a}], nil
}

func seqCode() func() (string, error) {
	n := 0
	return func() (string, error) { n++; return "SVCCODE" + string(rune('A'+n)), nil }
}

func TestCreateJoinDetailGating(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	stranger := seedUser(t, db, "Stranger")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{}, seqCode())

	g, err := svc.Create(context.Background(), owner, "Squad")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	joined, err := svc.JoinByCode(context.Background(), member, g.InviteCode)
	require.NoError(t, err)
	require.Equal(t, g.ID, joined.ID)

	// member can view detail; stranger cannot
	d, err := svc.Detail(context.Background(), member, g.ID)
	require.NoError(t, err)
	require.Len(t, d.Members, 2)
	_, err = svc.Detail(context.Background(), stranger, g.ID)
	require.ErrorIs(t, err, ErrForbidden)

	// only owner can rename
	require.ErrorIs(t, svc.Rename(context.Background(), member, g.ID, "x"), ErrForbidden)
	require.NoError(t, svc.Rename(context.Background(), owner, g.ID, "Renamed"))

	// owner cannot leave while others remain; member can
	require.ErrorIs(t, svc.Leave(context.Background(), owner, g.ID), ErrOwnerCannotLeave)
	require.NoError(t, svc.Leave(context.Background(), member, g.ID))
}

func TestInviteRequiresFriendship(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	friend := seedUser(t, db, "Friend")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{pairs: map[[2]uuid.UUID]bool{{owner, friend}: true}}, seqCode())

	g, err := svc.Create(context.Background(), owner, "Squad")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	// inviting a non-friend fails; inviting a friend adds them
	require.ErrorIs(t, svc.InviteFriend(context.Background(), owner, g.ID, uuid.New()), ErrNotFriends)
	require.NoError(t, svc.InviteFriend(context.Background(), owner, g.ID, friend))
	isM, err := repo.IsMember(context.Background(), g.ID, friend)
	require.NoError(t, err)
	require.True(t, isM)
}
```

- [ ] **Step 4: Run to verify fail** — `…go test ./internal/groups/...` → BUILD ERROR (NewService undefined).

- [ ] **Step 5: Write the service.** `api/internal/groups/service.go`:
```go
package groups

import (
	"context"

	"github.com/google/uuid"
)

type friendChecker interface {
	AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error)
}

type Service struct {
	repo    Repository
	friends friendChecker
	newCode func() (string, error)
}

func NewService(repo Repository, friends friendChecker, newCode func() (string, error)) Service {
	return Service{repo: repo, friends: friends, newCode: newCode}
}

type GroupDetail struct {
	ID         uuid.UUID    `json:"id"`
	Name       string       `json:"name"`
	InviteCode string       `json:"invite_code"`
	MyRole     Role         `json:"my_role"`
	Members    []MemberView `json:"members"`
}

func (s Service) Create(ctx context.Context, ownerID uuid.UUID, name string) (Group, error) {
	if name == "" {
		return Group{}, ErrBadInput
	}
	code, err := s.newCode()
	if err != nil {
		return Group{}, err
	}
	return s.repo.CreateGroup(ctx, ownerID, name, code)
}

func (s Service) JoinByCode(ctx context.Context, userID uuid.UUID, code string) (Group, error) {
	g, err := s.repo.FindByInviteCode(ctx, code)
	if err != nil {
		return Group{}, err
	}
	if g == nil {
		return Group{}, ErrNotFound
	}
	if err := s.repo.AddMember(ctx, g.ID, userID, RoleMember); err != nil {
		return Group{}, err
	}
	return *g, nil
}

func (s Service) InviteFriend(ctx context.Context, ownerID, groupID, friendID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	ok, err := s.friends.AreFriends(ctx, ownerID, friendID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFriends
	}
	return s.repo.AddMember(ctx, groupID, friendID, RoleMember)
}

func (s Service) Leave(ctx context.Context, userID, groupID uuid.UUID) error {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	if role == RoleOwner {
		return ErrOwnerCannotLeave
	}
	return s.repo.RemoveMember(ctx, groupID, userID)
}

func (s Service) RemoveMember(ctx context.Context, ownerID, groupID, memberID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	if memberID == ownerID {
		return ErrForbidden // owner can't remove themselves; delete instead
	}
	return s.repo.RemoveMember(ctx, groupID, memberID)
}

func (s Service) Rename(ctx context.Context, ownerID, groupID uuid.UUID, name string) error {
	if name == "" {
		return ErrBadInput
	}
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	return s.repo.Rename(ctx, groupID, name)
}

func (s Service) Delete(ctx context.Context, ownerID, groupID uuid.UUID) error {
	if err := s.requireOwner(ctx, ownerID, groupID); err != nil {
		return err
	}
	return s.repo.DeleteGroup(ctx, groupID)
}

func (s Service) ListGroups(ctx context.Context, userID uuid.UUID) ([]GroupSummary, error) {
	return s.repo.ListForUser(ctx, userID)
}

func (s Service) Detail(ctx context.Context, userID, groupID uuid.UUID) (GroupDetail, error) {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return GroupDetail{}, err
	}
	if !ok {
		return GroupDetail{}, ErrForbidden
	}
	g, err := s.repo.FindByID(ctx, groupID)
	if err != nil {
		return GroupDetail{}, err
	}
	if g == nil {
		return GroupDetail{}, ErrNotFound
	}
	members, err := s.repo.ListMembers(ctx, groupID)
	if err != nil {
		return GroupDetail{}, err
	}
	return GroupDetail{ID: g.ID, Name: g.Name, InviteCode: g.InviteCode, MyRole: role, Members: members}, nil
}

func (s Service) requireOwner(ctx context.Context, userID, groupID uuid.UUID) error {
	role, ok, err := s.repo.RoleOf(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	if role != RoleOwner {
		return ErrForbidden
	}
	return nil
}
```

- [ ] **Step 6: Run to verify pass** — `TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./internal/groups/... ./internal/social/... && go build ./...` → PASS, clean.

- [ ] **Step 7: Commit**
```bash
git add api/internal/groups/service.go api/internal/groups/errors.go api/internal/groups/service_test.go api/internal/social/repository.go api/internal/social/are_friends_test.go
git commit -m "feat(groups): group service (create/join/invite/leave/remove/rename/delete) + social.AreFriends"
```

---

### Task 3: Generalize `compare` → `ProgressForMembers`

**Files:**
- Modify: `api/internal/compare/service.go`
- Test: `api/internal/compare/members_test.go`

**Interfaces (produced):**
- `compare.Member{ID uuid.UUID; DisplayName string; ShareProgress bool; TargetKcal float64}`.
- `compare.Service.ProgressForMembers(ctx, day, loc, members []Member) ([]FriendProgress, error)` — the single consent gate.
- `Compare` (friends) refactored to build `[]Member` and call it — behavior unchanged.

- [ ] **Step 1: Write the failing test.** `api/internal/compare/members_test.go`:
```go
package compare

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestProgressForMembersGatesNonSharers(t *testing.T) {
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, stubLogs{})
	sharer := uuid.New()
	private := uuid.New()
	out, err := svc.ProgressForMembers(context.Background(), time.Now(), time.UTC, []Member{
		{ID: sharer, DisplayName: "Sharer", ShareProgress: true, TargetKcal: 2000},
		{ID: private, DisplayName: "Private", ShareProgress: false, TargetKcal: 2000},
	})
	require.NoError(t, err)
	require.Len(t, out, 2)
	byName := map[string]FriendProgress{}
	for _, f := range out {
		byName[f.DisplayName] = f
	}
	require.True(t, byName["Sharer"].Sharing)
	require.NotNil(t, byName["Sharer"].StreakDays)
	require.False(t, byName["Private"].Sharing)
	require.Nil(t, byName["Private"].StreakDays)
	require.Nil(t, byName["Private"].AdherenceDays)
}
```
(`stubFriends`/`stubUsers`/`stubLogs` already exist in `compare_test.go`.)

- [ ] **Step 2: Run to verify fail** — `go test ./internal/compare/...` → BUILD ERROR (`ProgressForMembers`/`Member` undefined).

- [ ] **Step 3: Refactor `compare/service.go`.** Add the `Member` type and `ProgressForMembers`, and rewrite `Compare`'s friend loop to use it:

Add after the `FriendProgress` type:
```go
// Member is the minimal per-user input to the consent-gated leaderboard.
type Member struct {
	ID            uuid.UUID
	DisplayName   string
	ShareProgress bool
	TargetKcal    float64
}

// ProgressForMembers is the single consent gate: a member's metrics are
// computed ONLY when ShareProgress is true; otherwise the metric pointers
// stay nil and serialize away (omitempty).
func (s Service) ProgressForMembers(ctx context.Context, day time.Time, loc *time.Location, members []Member) ([]FriendProgress, error) {
	out := make([]FriendProgress, 0, len(members))
	for _, m := range members {
		fp := FriendProgress{ID: m.ID, DisplayName: m.DisplayName, Sharing: m.ShareProgress}
		if m.ShareProgress {
			metrics, err := progress.Compute(ctx, s.logs, m.ID, m.TargetKcal, day, loc)
			if err != nil {
				return nil, err
			}
			streak, adh := metrics.StreakDays, metrics.AdherenceDays
			fp.StreakDays = &streak
			fp.AdherenceDays = &adh
		}
		out = append(out, fp)
	}
	return out, nil
}
```
Replace the friend loop in `Compare` (everything from `friends := make(...)` through the `return`) with:
```go
	members := make([]Member, 0, len(rows))
	for _, row := range rows {
		members = append(members, Member{ID: row.ID, DisplayName: row.DisplayName, ShareProgress: row.ShareProgress, TargetKcal: row.TargetKcal})
	}
	friends, err := s.ProgressForMembers(ctx, day, loc, members)
	if err != nil {
		return Result{}, err
	}
	return Result{Me: meMetrics, Friends: friends}, nil
```

- [ ] **Step 4: Run to verify pass** — `TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./internal/compare/... && go build ./...` → PASS (new + existing compare tests green; the friends `Compare` behavior is unchanged).

- [ ] **Step 5: Commit**
```bash
git add api/internal/compare/service.go api/internal/compare/members_test.go
git commit -m "refactor(compare): extract ProgressForMembers consent gate (reused by groups)"
```

---

### Task 4: `groups` handlers + routes (incl. group leaderboard)

**Files:**
- Create: `api/internal/groups/handler.go`
- Modify: `api/internal/server/router.go`
- Test: `api/internal/groups/handler_test.go`

**Interfaces:** `groups.NewHandler(svc Service, repo Repository, compareSvc compare.Service) Handler`; `groups.NewCode() (string, error)`. Routes under authed `/v1`.

- [ ] **Step 1: Write the handler.** `api/internal/groups/handler.go`:
```go
package groups

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc     Service
	repo    Repository
	compare compare.Service
}

func NewHandler(svc Service, repo Repository, compareSvc compare.Service) Handler {
	return Handler{svc: svc, repo: repo, compare: compareSvc}
}

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
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
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid input")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "group not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	case errors.Is(err, ErrOwnerCannotLeave):
		httpx.Error(c, http.StatusConflict, "conflict", "owner cannot leave; delete the group instead")
	case errors.Is(err, ErrNotFriends):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "you can only invite a friend")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

func (h Handler) parseID(c *gin.Context, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(param))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

type nameBody struct {
	Name string `json:"name"`
}
type codeBody struct {
	Code string `json:"code"`
}
type inviteBody struct {
	UserID string `json:"user_id"`
}

func (h Handler) Create(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req nameBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	g, err := h.svc.Create(c.Request.Context(), uid, req.Name)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": g})
}

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gs, err := h.svc.ListGroups(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gs)
}

func (h Handler) Join(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req codeBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	g, err := h.svc.JoinByCode(c.Request.Context(), uid, req.Code)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, g)
}

func (h Handler) Detail(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	d, err := h.svc.Detail(c.Request.Context(), uid, gid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, d)
}

func (h Handler) Code(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	isM, err := h.repo.IsMember(c.Request.Context(), gid, uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	if !isM {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
		return
	}
	g, err := h.repo.FindByID(c.Request.Context(), gid)
	if err != nil || g == nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "group not found")
		return
	}
	httpx.OK(c, gin.H{"code": g.InviteCode, "link": "mobile://group/" + g.InviteCode})
}

func (h Handler) Progress(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	isM, err := h.repo.IsMember(c.Request.Context(), gid, uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	if !isM {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
		return
	}
	rows, err := h.repo.ListMembersForProgress(c.Request.Context(), gid)
	if err != nil {
		mapErr(c, err)
		return
	}
	members := make([]compare.Member, 0, len(rows))
	for _, r := range rows {
		members = append(members, compare.Member{ID: r.ID, DisplayName: r.DisplayName, ShareProgress: r.ShareProgress, TargetKcal: r.TargetKcal})
	}
	out, err := h.compare.ProgressForMembers(c.Request.Context(), time.Now(), user.LocFromContext(c), members)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	httpx.OK(c, gin.H{"members": out})
}

func (h Handler) Invite(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req inviteBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	friendID, err := uuid.Parse(req.UserID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid user_id")
		return
	}
	if err := h.svc.InviteFriend(c.Request.Context(), uid, gid, friendID); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"invited": true})
}

func (h Handler) RemoveMember(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	memberID, ok := h.parseID(c, "userId")
	if !ok {
		return
	}
	// self -> leave; other -> owner-remove
	var err error
	if memberID == uid {
		err = h.svc.Leave(c.Request.Context(), uid, gid)
	} else {
		err = h.svc.RemoveMember(c.Request.Context(), uid, gid, memberID)
	}
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"removed": true})
}

func (h Handler) Rename(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req nameBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	if err := h.svc.Rename(c.Request.Context(), uid, gid, req.Name); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"renamed": true})
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), uid, gid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
```

- [ ] **Step 2: Wire routes in `server/router.go`.** Add `"github.com/tesserix/kora/api/internal/groups"` import. After the compare wiring, add:
```go
			groupsRepo := groups.NewRepository(deps.DB)
			groupsSvc := groups.NewService(groupsRepo, socialRepo, groups.NewCode)
			groupsHandler := groups.NewHandler(groupsSvc, groupsRepo, compare.NewService(socialRepo, userRepo, logRepo))
			v1.POST("/groups", groupsHandler.Create)
			v1.GET("/groups", groupsHandler.List)
			v1.POST("/groups/join", groupsHandler.Join)
			v1.GET("/groups/:id", groupsHandler.Detail)
			v1.GET("/groups/:id/code", groupsHandler.Code)
			v1.GET("/groups/:id/progress", groupsHandler.Progress)
			v1.POST("/groups/:id/invite", groupsHandler.Invite)
			v1.DELETE("/groups/:id/members/:userId", groupsHandler.RemoveMember)
			v1.PATCH("/groups/:id", groupsHandler.Rename)
			v1.DELETE("/groups/:id", groupsHandler.Delete)
```
Add a code generator to the `groups` package — in `service.go` (or a small `code.go`):
```go
// NewCode generates an 8-char Crockford base32 invite code.
func NewCode() (string, error) {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b), nil
}
```
(Add `"crypto/rand"` to that file's imports.)

Note on routing: `GET /groups` (static) and `GET /groups/:id` (param) coexist — different path depth, no conflict. `POST /groups` and `POST /groups/join` — `join` is a static child, `:id` is not used for POST at that level, so no conflict. `DELETE /groups/:id` and `DELETE /groups/:id/members/:userId` — different depths, fine.

- [ ] **Step 3: Write the handler test.** `api/internal/groups/handler_test.go` — mount the routes with a middleware that sets `user_id`, exercise the key status codes:
```go
package groups

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	repo := NewRepository(db)
	svc := NewService(repo, social.NewRepository(db), NewCode)
	h := NewHandler(svc, repo, compare.NewService(social.NewRepository(db), user.NewRepository(db), foodLogSourceFor(db)))
	r.POST("/v1/groups", h.Create)
	r.GET("/v1/groups", h.List)
	r.POST("/v1/groups/join", h.Join)
	r.GET("/v1/groups/:id", h.Detail)
	r.GET("/v1/groups/:id/progress", h.Progress)
	r.PATCH("/v1/groups/:id", h.Rename)
	r.DELETE("/v1/groups/:id", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestCreateThenNonMemberDetailForbidden(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	stranger := seedUser(t, db, "Stranger")

	rOwner := mountFor(owner, db)
	w := doJSON(rOwner, http.MethodPost, "/v1/groups", `{"name":"Squad"}`)
	require.Equal(t, http.StatusCreated, w.Code)

	// list to grab the id
	wl := doJSON(rOwner, http.MethodGet, "/v1/groups", "")
	require.Equal(t, http.StatusOK, wl.Code)
	// crude id extraction
	id := extractFirstGroupID(t, db, owner)

	rStranger := mountFor(stranger, db)
	wd := doJSON(rStranger, http.MethodGet, "/v1/groups/"+id.String(), "")
	require.Equal(t, http.StatusForbidden, wd.Code)
}
```
Provide the two helpers this test references — `foodLogSourceFor(db)` returns a `foodlog.Repository` (`import "github.com/tesserix/kora/api/internal/foodlog"; func foodLogSourceFor(db *gorm.DB) foodlog.Repository { return foodlog.NewRepository(db) }`), and `extractFirstGroupID(t, db, owner)` queries the owner's single group id:
```go
func extractFirstGroupID(t *testing.T, db *gorm.DB, owner uuid.UUID) uuid.UUID {
	var id uuid.UUID
	require.NoError(t, db.Raw("SELECT g.id FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? LIMIT 1", owner).Scan(&id).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", id) })
	return id
}
```

- [ ] **Step 4: Run the whole suite + build** — `TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./... && go build ./...` → green; build clean (confirms all `/groups*` routes coexist).

- [ ] **Step 5: Commit**
```bash
git add api/internal/groups/handler.go api/internal/groups/handler_test.go api/internal/server/router.go api/internal/groups/service.go
git commit -m "feat(groups): HTTP handlers + routes + group leaderboard"
```

---

### Task 5: Mobile types + group hooks

**Files:**
- Modify: `apps/mobile/src/api/types.ts`, `apps/mobile/src/api/hooks.ts`
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx`

**Interfaces (produced):** types `GroupSummary`, `GroupMemberView`, `GroupDetail`, `GroupProgress`, `GroupCode`; hooks `useGroups`, `useGroup`, `useGroupProgress`, `useGroupCode`, `useCreateGroup`, `useJoinGroup`, `useLeaveGroup`, `useRemoveMember`, `useDeleteGroup`. (Rename + direct friend-invite hooks are deferred with their UI — see Task 7 scope note; the backend endpoints exist.)

- [ ] **Step 1: Failing tests.** Append three representative tests to `hooks.test.tsx` (create posts name; join posts code; leave DELETEs member) and add the hook names to the `"../hooks"` import:
```tsx
test("useCreateGroup POSTs the name to /v1/groups", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "g1", name: "Squad" });
  const { result } = await renderHook(() => useCreateGroup(), { wrapper });
  result.current.mutate("Squad");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups", { method: "POST", body: JSON.stringify({ name: "Squad" }) });
});

test("useJoinGroup POSTs the code to /v1/groups/join", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ id: "g1" });
  const { result } = await renderHook(() => useJoinGroup(), { wrapper });
  result.current.mutate("CODE1234");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/join", { method: "POST", body: JSON.stringify({ code: "CODE1234" }) });
});

test("useLeaveGroup DELETEs /v1/groups/:id/members/:userId", async () => {
  (apiFetch as jest.Mock).mockResolvedValueOnce({ removed: true });
  const { result } = await renderHook(() => useLeaveGroup(), { wrapper });
  result.current.mutate({ groupId: "g1", userId: "u1" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(apiFetch).toHaveBeenCalledWith("/v1/groups/g1/members/u1", { method: "DELETE" });
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci hooks.test` → FAIL.

- [ ] **Step 3: Types.** In `types.ts` append:
```ts
export type GroupRole = "owner" | "member";

export interface GroupSummary {
  id: string;
  name: string;
  member_count: number;
  role: GroupRole;
}

export interface GroupMemberView {
  id: string;
  display_name: string;
  role: GroupRole;
}

export interface GroupDetail {
  id: string;
  name: string;
  invite_code: string;
  my_role: GroupRole;
  members: GroupMemberView[];
}

export interface GroupProgress {
  members: FriendProgress[];
}

export interface GroupCode {
  code: string;
  link: string;
}
```

- [ ] **Step 4: Hooks.** In `hooks.ts`, add the new types to the `"./types"` import, then append:
```ts
export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: () => apiFetch("/v1/groups") as Promise<GroupSummary[]> });
}

export function useGroup(id: string) {
  return useQuery({ queryKey: ["group", id], queryFn: () => apiFetch(`/v1/groups/${id}`) as Promise<GroupDetail>, enabled: !!id });
}

export function useGroupProgress(id: string) {
  return useQuery({ queryKey: ["group-progress", id], queryFn: () => apiFetch(`/v1/groups/${id}/progress`) as Promise<GroupProgress>, enabled: !!id });
}

export function useGroupCode(id: string) {
  return useQuery({ queryKey: ["group-code", id], queryFn: () => apiFetch(`/v1/groups/${id}/code`) as Promise<GroupCode>, enabled: !!id });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch("/v1/groups", { method: "POST", body: JSON.stringify({ name }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useJoinGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiFetch("/v1/groups/join", { method: "POST", body: JSON.stringify({ code }) }) as Promise<GroupSummary>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}

export function useLeaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", groupId] });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiFetch(`/v1/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_d, { groupId }) => qc.invalidateQueries({ queryKey: ["group", groupId] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => apiFetch(`/v1/groups/${groupId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });
}
```

- [ ] **Step 5: Run to verify pass** — `npm test -- --ci hooks.test && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): group types + query hooks"
```

---

### Task 6: Groups list screen (list + create + join)

**Files:**
- Create: `apps/mobile/app/groups.tsx`
- Create: `apps/mobile/src/components/social/CreateGroupSheet.tsx`
- Test: `apps/mobile/app/__tests__/groups.test.tsx`

**Interfaces:** a `/groups` route (default export). `CreateGroupSheet({visible, mode, onClose})` where `mode` is `"create"|"join"`.

- [ ] **Step 1: Failing test.** `apps/mobile/app/__tests__/groups.test.tsx`:
```tsx
import { render, fireEvent } from "@testing-library/react-native";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useGroups: () => ({ data: [{ id: "g1", name: "Squad", member_count: 3, role: "owner" }] }),
  useCreateGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useJoinGroup: () => ({ mutate: jest.fn(), isPending: false }),
}));

import Groups from "../groups";

test("lists my groups and navigates to detail on tap", async () => {
  const { getByText } = await render(<Groups />);
  expect(getByText("Squad")).toBeTruthy();
  expect(getByText("3 members")).toBeTruthy();
  await fireEvent.press(getByText("Squad"));
  expect(mockPush).toHaveBeenCalledWith("/group/g1");
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci groups.test` → FAIL.

- [ ] **Step 3: Write `CreateGroupSheet`.** `apps/mobile/src/components/social/CreateGroupSheet.tsx`:
```tsx
import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCreateGroup, useJoinGroup } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { GroupSummary } from "@/api/types";

interface Props {
  visible: boolean;
  mode: "create" | "join";
  onClose: () => void;
}

export function CreateGroupSheet({ visible, mode, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateGroup();
  const join = useJoinGroup();
  const isCreate = mode === "create";
  const pending = create.isPending || join.isPending;

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr(isCreate ? "Name your group." : "Enter a group code.");
      return;
    }
    setErr(null);
    const done = (g: GroupSummary) => {
      setValue("");
      onClose();
      router.push(`/group/${g.id}`);
    };
    if (isCreate) create.mutate(v, { onSuccess: done, onError: () => setErr("Couldn't create. Try again.") });
    else join.mutate(v, { onSuccess: done, onError: () => setErr("No group matches that code.") });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{isCreate ? "Create a group" : "Join a group"}</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize={isCreate ? "words" : "characters"}
          autoCorrect={false}
          placeholder={isCreate ? "Group name" : "Group code"}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={isCreate ? "Group name" : "Group code"}
          style={{ marginTop: 12, fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title={isCreate ? "Create group" : "Join group"} onPress={onSubmit} disabled={pending} style={{ marginTop: 14 }} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Write `groups.tsx`.** `apps/mobile/app/groups.tsx`:
```tsx
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { CreateGroupSheet } from "@/components/social/CreateGroupSheet";
import { useGroups } from "@/api/hooks";
import { useTheme } from "@/theme";

export default function Groups() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const groups = useGroups();
  const [sheet, setSheet] = useState<null | "create" | "join">(null);
  const list = groups.data ?? [];

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your groups" title="Groups" />
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="Create group" onPress={() => setSheet("create")} style={{ flex: 1 }} />
            <Button title="Join by code" variant="secondary" onPress={() => setSheet("join")} style={{ flex: 1 }} />
          </View>

          {list.length === 0 ? (
            <AppText muted style={{ paddingVertical: 12 }}>No groups yet. Create one or join with a code.</AppText>
          ) : (
            list.map((g) => (
              <Pressable
                key={g.id}
                accessibilityRole="button"
                onPress={() => router.push(`/group/${g.id}`)}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                <Icon name="users" size={18} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{g.name}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{`${g.member_count} ${g.member_count === 1 ? "member" : "members"}`}</AppText>
                </View>
                {g.role === "owner" ? <AppText muted style={{ fontSize: 11 }}>Owner</AppText> : null}
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
      {sheet ? <CreateGroupSheet visible mode={sheet} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
```

- [ ] **Step 5: Run to verify pass + typecheck** — `npm test -- --ci groups.test && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**
```bash
git add apps/mobile/app/groups.tsx apps/mobile/src/components/social/CreateGroupSheet.tsx apps/mobile/app/__tests__/groups.test.tsx
git commit -m "feat(mobile): groups list + create/join sheet"
```

---

### Task 7: Group detail screen (roster + leaderboard + owner controls)

**Files:**
- Create: `apps/mobile/app/group/[id].tsx`
- Test: `apps/mobile/app/__tests__/group-detail.test.tsx`

**Interfaces:** the `/group/[id]` route (default export). Renders its own peer-ranked board from `useGroupProgress` (a group has no "You" anchor row, so it does not reuse `FriendsLeaderboard`).

- [ ] **Step 1: Failing test.** `apps/mobile/app/__tests__/group-detail.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { back: jest.fn() }, useLocalSearchParams: () => ({ id: "g1" }) }));
jest.mock("@/api/hooks", () => ({
  useGroup: () => ({ data: { id: "g1", name: "Squad", invite_code: "CODE1234", my_role: "owner", members: [
    { id: "u1", display_name: "Owner", role: "owner" },
    { id: "u2", display_name: "Mate", role: "member" },
  ] } }),
  useGroupProgress: () => ({ data: { members: [
    { id: "u1", display_name: "Owner", sharing: true, streak_days: 5, adherence_days: 4 },
    { id: "u2", display_name: "Mate", sharing: false },
  ] } }),
  useGroupCode: () => ({ data: { code: "CODE1234", link: "mobile://group/CODE1234" } }),
  useLeaveGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useRemoveMember: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useProfile: () => ({ data: { id: "u1" } }),
}));

import GroupDetail from "../group/[id]";

test("renders name, roster, leaderboard, and owner-only Delete", async () => {
  const { getByText } = await render(<GroupDetail />);
  expect(getByText("Squad")).toBeTruthy();
  expect(getByText("Owner")).toBeTruthy();
  expect(getByText("Mate")).toBeTruthy();
  expect(getByText("4/7 on target")).toBeTruthy(); // leaderboard, sharing member
  expect(getByText("Delete group")).toBeTruthy(); // my_role owner
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci group-detail` → FAIL.

- [ ] **Step 3: Write `group/[id].tsx`.** `apps/mobile/app/group/[id].tsx`:
```tsx
import { Alert, Pressable, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { useGroup, useGroupProgress, useGroupCode, useLeaveGroup, useRemoveMember, useDeleteGroup, useProfile } from "@/api/hooks";
import { useTheme } from "@/theme";

// A group board has no "You" anchor row (every member is a peer), so this screen
// renders its own ranked list rather than reusing FriendsLeaderboard.

export default function GroupDetail() {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useGroup(id);
  const progress = useGroupProgress(id);
  const code = useGroupCode(id);
  const leave = useLeaveGroup();
  const removeMember = useRemoveMember();
  const del = useDeleteGroup();

  const profile = useProfile();
  const d = detail.data;
  const isOwner = d?.my_role === "owner";
  const members = progress.data?.members ?? [];
  const sharing = members.filter((m) => m.sharing);
  const notSharing = members.filter((m) => !m.sharing);
  const ranked = [...sharing].sort((a, b) => (b.streak_days ?? 0) - (a.streak_days ?? 0) || (b.adherence_days ?? 0) - (a.adherence_days ?? 0));

  const shareCode = () => {
    if (code.data) Share.share({ message: code.data.link }).catch(() => {});
  };

  const onDelete = () =>
    Alert.alert("Delete this group?", "This removes it for everyone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => del.mutate(id, { onSuccess: () => router.back() }) },
    ]);

  const onLeave = () =>
    Alert.alert("Leave this group?", "", [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => leave.mutate({ groupId: id, userId: profile.data?.id ?? "" }, { onSuccess: () => router.back() }) },
    ]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Group" title={d?.name ?? "Group"} />
      <View style={{ paddingHorizontal: 20, gap: 20 }}>
        <Button title="Share invite code" onPress={shareCode} variant="secondary" />

        <View style={{ gap: 10 }}>
          <Overline>Leaderboard</Overline>
          {ranked.map((m, i) => (
            <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
              <AppText muted style={{ fontSize: 14 }}>{i + 1}</AppText>
              <View style={{ flex: 1 }}>
                <AppText style={{ fontSize: 15, fontWeight: "600" }}>{m.display_name}</AppText>
                <AppText muted style={{ fontSize: 12 }}>{`${m.adherence_days ?? 0}/7 on target`}</AppText>
              </View>
              <AppText style={{ fontSize: 16, fontWeight: "700" }}>{m.streak_days ?? 0}</AppText>
            </View>
          ))}
        </View>

        <View style={{ gap: 8 }}>
          <Overline>Members</Overline>
          {(d?.members ?? []).map((m) => (
            <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
              <AppText style={{ flex: 1, fontSize: 15 }}>{m.display_name}</AppText>
              <AppText muted style={{ fontSize: 11 }}>{m.role}</AppText>
              {isOwner && m.role !== "owner" ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${m.display_name}`} onPress={() => removeMember.mutate({ groupId: id, userId: m.id })}>
                  <AppText style={{ color: colors.destructive, fontSize: 13 }}>Remove</AppText>
                </Pressable>
              ) : null}
            </View>
          ))}
          {notSharing.length > 0 ? <AppText muted style={{ fontSize: 12 }}>{`${notSharing.length} not sharing progress`}</AppText> : null}
        </View>

        {isOwner ? (
          <Button title="Delete group" variant="ghost" onPress={onDelete} />
        ) : (
          <Button title="Leave group" variant="ghost" onPress={onLeave} />
        )}
      </View>
    </ScrollView>
  );
}
```
The self-leave uses `profile.data?.id` with the existing `DELETE /groups/:id/members/:userId` endpoint (the Task 4 handler routes `memberID == caller → Leave`) — no new endpoint needed. Owner sees "Delete group" instead of "Leave group", so the owner-cannot-leave path isn't reachable from the UI.

**Scope note (deliberate):** this screen wires share-code (the primary invite path), the leaderboard, the roster, owner remove-member + delete, and non-owner leave. The **rename affordance and the direct friend-invite picker are DEFERRED** — their backend endpoints (`PATCH /groups/:id`, `POST /groups/:id/invite`) and the `AreFriends` guard exist and are tested, but the mobile UI + hooks (`useRenameGroup`, `useInviteToGroup`) are a follow-up. Not a silent gap — logged here.

- [ ] **Step 4: Run to verify pass + full suite + typecheck** — `npm test -- --ci group-detail && npx tsc --noEmit && npm test -- --ci` → PASS; whole suite green.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/app/group/\[id\].tsx apps/mobile/app/__tests__/group-detail.test.tsx
git commit -m "feat(mobile): group detail screen with roster + leaderboard + owner controls"
```

---

### Task 8: More-tab "Groups" row

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`
- Modify: `apps/mobile/app/(tabs)/__tests__/more.test.tsx`

- [ ] **Step 1: Failing test.** In `more.test.tsx`, add:
```tsx
test("tapping Groups navigates to /groups", async () => {
  const { getByText } = await render(<More />);
  await fireEvent.press(getByText("Groups"));
  expect(mockPush).toHaveBeenCalledWith("/groups");
});
```

- [ ] **Step 2: Run to verify fail** — `npm test -- --ci more.test` → FAIL.

- [ ] **Step 3: Add the row.** In `more.tsx`, add a Groups row right after the Friends row:
```tsx
  { icon: "users", label: "Groups", route: "/groups" },
```
(Place it as the second entry, after Friends. The row rendering already navigates via `router.push(r.route as Href)`.)

- [ ] **Step 4: Run to verify pass + full suite + typecheck** — `npm test -- --ci more.test && npx tsc --noEmit && npm test -- --ci` → PASS; whole suite green.

- [ ] **Step 5: Commit**
```bash
git add apps/mobile/app/\(tabs\)/more.tsx apps/mobile/app/\(tabs\)/__tests__/more.test.tsx
git commit -m "feat(mobile): Groups row in the More tab"
```

---

## Final verification (after all tasks)

- [ ] Backend: `cd api && TEST_DATABASE_URL=…/kora_test go test -race -p 1 -count=1 ./... && go build ./...` — green.
- [ ] Mobile: `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` — green.
- [ ] Final whole-branch review on the most capable model. Emphasis: (1) the leaderboard consent gate still routes through the single `compare.ProgressForMembers`; (2) every group read is membership-gated; (3) owner-only mutations reject members.
- [ ] Do NOT push until the user approves.

## Notes for implementers
- Stale RED LSP diagnostics after a test-before-impl step are normal on Go — verify with `go build ./...` / `go test`.
- Backend service/handler tests use one `db := testDB(t)` handle per test, seeded with the package's `seedUser(t, db, name)`; stub the `friendChecker` in service tests, use the real `social.NewRepository(db)` in handler tests.
- `Button` variants: `"primary" | "secondary" | "ghost"`. `router.push(path as Href)` for dynamic routes (import `type Href` from `expo-router`).
- Self-leave (Task 7) sends `profile.data?.id` to the existing `DELETE /groups/:id/members/:userId` (the handler routes self → `Leave`); no dedicated leave endpoint is added.
