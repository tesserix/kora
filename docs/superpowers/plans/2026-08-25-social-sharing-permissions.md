# Social Sharing Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global `users.share_progress` boolean with per-circle, per-category sharing, enforced by a gateway every cross-user read must pass through.

**Architecture:** Three tables owned by the sharer (`share_circles`, `share_circle_members`, `share_grants`). A new `api/internal/access` package resolves "may viewer V see category C of owner O" into a `Grant` value with unexported fields. Cross-user read services take a `Grant`, never a bare owner UUID, so a forged grant resolves to `uuid.Nil` and returns zero rows rather than someone else's data.

**Tech Stack:** Go 1.26, Gin, GORM, PostgreSQL, golang-migrate, testify.

**Spec:** `docs/superpowers/specs/2026-08-25-social-sharing-permissions-design.md`

## Global Constraints

- **Test database is on port 5433, not 5432.** 5432 in this workspace is an unrelated tesserix-marketplace database. Every DB test run needs `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable`. The default in `testDB(t)` is 5432 and is wrong here.
- **Run DB suites with `-p 1`.** They do not close their gorm pools and exhaust `max_connections` when run concurrently.
- **The repo is PUBLIC.** Never put a real weight, measurement, intake value or user ID in a commit, comment, test fixture, issue or PR.
- **Single-line commit messages, no signatures.**
- **Editor diagnostics lie here.** Stale gopls snapshots report compile errors on files that `go build ./...` accepts. Verify with the compiler before believing them.
- **Category values must match on both sides.** The Go allow-list and any DB constraint are two halves of one rule — the pattern `tracking.Sources` follows for `weight_entries_source_check`.
- Migration numbering continues from `000053`; this plan uses `000054`.

---

### Task 1: Schema and migration

**Files:**
- Create: `api/internal/database/migrations/000054_share_circles.up.sql`
- Create: `api/internal/database/migrations/000054_share_circles.down.sql`

**Interfaces:**
- Consumes: nothing
- Produces: tables `share_circles`, `share_circle_members`, `share_grants`; `users.share_progress` still present (dropped in Task 8)

- [ ] **Step 1: Write the up migration**

```sql
-- Per-circle, per-category sharing (kora#326). Replaces users.share_progress,
-- a single global boolean that gated exactly one category for every friend at
-- once. Visibility is a function of (viewer, category), never one switch.
--
-- Direction falls out of ownership: a circle belongs to its owner and exposes
-- ONLY that owner's data. The reverse grant is a different row in a different
-- circle, so "I share my weight with my spouse" never implies the reverse.
CREATE TABLE share_circles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT share_circles_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX share_circles_owner_name
    ON share_circles (owner_id, lower(btrim(name)));

CREATE TABLE share_circle_members (
    circle_id      UUID NOT NULL REFERENCES share_circles(id) ON DELETE CASCADE,
    member_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, member_user_id)
);

-- Resolution asks "which circles containing V are owned by O", so the member
-- side is the leading column of the lookup.
CREATE INDEX idx_share_circle_members_member
    ON share_circle_members (member_user_id, circle_id);

-- `category` is TEXT validated by a Go allow-list, not a Postgres enum:
-- adding a category later must not need ALTER TYPE. Same arrangement as
-- weight_entries_source_check and tracking.Sources -- the two halves are one
-- rule, so a new category must be added to BOTH or writes fail the CHECK.
CREATE TABLE share_grants (
    circle_id  UUID NOT NULL REFERENCES share_circles(id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (circle_id, category),
    CONSTRAINT share_grants_category_check
        CHECK (category IN ('progress', 'body'))
);
```

- [ ] **Step 2: Write the down migration**

```sql
DROP TABLE IF EXISTS share_grants;
DROP TABLE IF EXISTS share_circle_members;
DROP TABLE IF EXISTS share_circles;
```

- [ ] **Step 3: Apply the migration against the test database**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go run ./api/cmd/migrate up` (if no such command exists, apply with `psql` and note it in the commit message)

Expected: three tables created, no error.

- [ ] **Step 4: Verify the down migration is reversible**

Run the down migration, then the up migration again. Expected: no error either way.

- [ ] **Step 5: Commit**

```bash
git add api/internal/database/migrations/000054_share_circles.up.sql api/internal/database/migrations/000054_share_circles.down.sql
git commit -m "feat(share): tables for per-circle, per-category sharing (#326)"
```

---

### Task 2: The access package — category allow-list and Grant type

**Files:**
- Create: `api/internal/access/model.go`
- Test: `api/internal/access/model_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: `access.Category` (string type), `access.CategoryProgress`, `access.CategoryBody`, `access.Categories []Category`, `access.Category.Valid() bool`, `access.Grant` with method `Owner() uuid.UUID`

- [ ] **Step 1: Write the failing test**

```go
package access

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestCategoryValid(t *testing.T) {
	require.True(t, CategoryProgress.Valid())
	require.True(t, CategoryBody.Valid())
	require.False(t, Category("recipes").Valid())
	require.False(t, Category("").Valid())
}

// The allow-list and share_grants_category_check in migration 000054 are one
// rule in two places. This pins the Go half so a category added here without
// the CHECK is caught by a test rather than by a failing INSERT in production.
func TestCategoriesListMatchesConstants(t *testing.T) {
	require.Equal(t, []Category{CategoryProgress, CategoryBody}, Categories)
}

// THE invariant behind the whole package: a Grant that did not come from
// Resolve carries no owner, so it reads nobody's data. Other packages can
// write access.Grant{} -- they cannot put an owner in it.
func TestZeroGrantHasNoOwner(t *testing.T) {
	require.Equal(t, uuid.Nil, Grant{}.Owner())
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./api/internal/access/ -run 'TestCategory|TestZeroGrant' -v`
Expected: FAIL — `undefined: CategoryProgress`

- [ ] **Step 3: Write the implementation**

```go
// Package access answers one question: may this viewer see this category of
// this owner's data (kora#326)?
//
// It exists because there is no owner-scoping abstraction in this API to hang
// the check on -- ownership is ~57 hand-written `user_id = ?` filters, and a
// new cross-user endpoint would inherit no protection at all.
package access

import "github.com/google/uuid"

type Category string

const (
	CategoryProgress Category = "progress" // streak_days, adherence_days
	CategoryBody     Category = "body"     // weight, measurements, body fat
)

// Categories is the allow-list, mirroring share_grants_category_check in
// migration 000054. Changing one side alone makes the CHECK reject a write the
// Go layer accepted, so change both.
var Categories = []Category{CategoryProgress, CategoryBody}

func (c Category) Valid() bool {
	for _, known := range Categories {
		if c == known {
			return true
		}
	}
	return false
}

// Grant is proof that a specific viewer may read a specific category of a
// specific owner. Its fields are unexported and only Resolve/ResolveMany set
// them.
//
// This is FAIL-SAFE, not uncircumventable. Go permits `access.Grant{}` from any
// package -- only the fields are unreachable. Such a grant carries uuid.Nil as
// its owner, so a service using grant.Owner() as its query key reads zero rows.
// The failure mode of bypassing this package is NO DATA, never SOMEONE ELSE'S
// DATA. Do not restate that as "impossible"; it is not.
type Grant struct {
	viewer   uuid.UUID
	owner    uuid.UUID
	category Category
}

// Owner is the only key a cross-user read may query by.
func (g Grant) Owner() uuid.UUID { return g.owner }

func (g Grant) Viewer() uuid.UUID { return g.viewer }

func (g Grant) Category() Category { return g.category }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./api/internal/access/ -run 'TestCategory|TestZeroGrant' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/internal/access/model.go api/internal/access/model_test.go
git commit -m "feat(access): category allow-list and the unforgeable Grant type (#326)"
```

---

### Task 3: Grant resolution

**Files:**
- Create: `api/internal/access/repository.go`
- Create: `api/internal/access/service.go`
- Create: `api/internal/access/errors.go`
- Test: `api/internal/access/service_test.go`

**Interfaces:**
- Consumes: `access.Category`, `access.Grant` (Task 2); tables from Task 1
- Produces:
  - `access.NewRepository(db *gorm.DB) Repository`
  - `access.NewService(repo Repository) Service`
  - `(Service) Resolve(ctx context.Context, viewer, owner uuid.UUID, c Category) (Grant, error)`
  - `(Service) ResolveMany(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, c Category) (map[uuid.UUID]Grant, error)`
  - `access.ErrNotShared`

- [ ] **Step 1: Write the failing test**

```go
package access

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
		url = "postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable"
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
		`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`,
		id, id.String()+"@example.test", name).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

func seedCircle(t *testing.T, db *gorm.DB, owner uuid.UUID, name string, members []uuid.UUID, cats []Category) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)`, id, owner, name).Error)
	for _, m := range members {
		require.NoError(t, db.Exec(
			`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)`, id, m).Error)
	}
	for _, c := range cats {
		require.NoError(t, db.Exec(
			`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`, id, string(c)).Error)
	}
	return id
}

func TestResolveGrantsWhenCircleMemberHasCategory(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	viewer := seedUser(t, db, "viewer")
	seedCircle(t, db, owner, "Household", []uuid.UUID{viewer}, []Category{CategoryBody})

	g, err := svc.Resolve(context.Background(), viewer, owner, CategoryBody)
	require.NoError(t, err)
	require.Equal(t, owner, g.Owner())
	require.Equal(t, viewer, g.Viewer())
}

func TestResolveRefusesACategoryTheCircleWasNotGranted(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	viewer := seedUser(t, db, "viewer")
	seedCircle(t, db, owner, "Gym", []uuid.UUID{viewer}, []Category{CategoryProgress})

	_, err := svc.Resolve(context.Background(), viewer, owner, CategoryBody)
	require.ErrorIs(t, err, ErrNotShared)
}

func TestResolveRefusesANonMember(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	stranger := seedUser(t, db, "stranger")
	seedCircle(t, db, owner, "Household", nil, []Category{CategoryBody})

	_, err := svc.Resolve(context.Background(), stranger, owner, CategoryBody)
	require.ErrorIs(t, err, ErrNotShared)
}

// Grants are one-directional by construction: a circle exposes only its
// owner's data. Sharing with a spouse must not expose the spouse.
func TestResolveIsNotReciprocal(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	viewer := seedUser(t, db, "viewer")
	seedCircle(t, db, owner, "Household", []uuid.UUID{viewer}, []Category{CategoryBody})

	_, err := svc.Resolve(context.Background(), owner, viewer, CategoryBody)
	require.ErrorIs(t, err, ErrNotShared)
}

func TestResolveRefusesAnUnknownCategory(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	viewer := seedUser(t, db, "viewer")

	_, err := svc.Resolve(context.Background(), viewer, owner, Category("recipes"))
	require.ErrorIs(t, err, ErrNotShared)
}

func TestResolveManyReturnsOnlyGrantedOwners(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	viewer := seedUser(t, db, "viewer")
	shared := seedUser(t, db, "shared")
	notShared := seedUser(t, db, "notshared")
	seedCircle(t, db, shared, "Household", []uuid.UUID{viewer}, []Category{CategoryProgress})

	got, err := svc.ResolveMany(context.Background(), viewer,
		[]uuid.UUID{shared, notShared}, CategoryProgress)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, shared, got[shared].Owner())
	_, present := got[notShared]
	require.False(t, present)
}

// Two circles both granting the same category must not yield two grants.
func TestResolveManyDeduplicatesOverlappingCircles(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	viewer := seedUser(t, db, "viewer")
	owner := seedUser(t, db, "owner")
	seedCircle(t, db, owner, "Household", []uuid.UUID{viewer}, []Category{CategoryProgress})
	seedCircle(t, db, owner, "Gym", []uuid.UUID{viewer}, []Category{CategoryProgress})

	got, err := svc.ResolveMany(context.Background(), viewer, []uuid.UUID{owner}, CategoryProgress)
	require.NoError(t, err)
	require.Len(t, got, 1)
}

func TestResolveManyWithNoOwnersDoesNotQuery(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	viewer := seedUser(t, db, "viewer")

	got, err := svc.ResolveMany(context.Background(), viewer, nil, CategoryProgress)
	require.NoError(t, err)
	require.Empty(t, got)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/access/ -p 1 -v`
Expected: FAIL — `undefined: NewService`

- [ ] **Step 3: Write the implementation**

`api/internal/access/errors.go`:

```go
package access

import "errors"

// ErrNotShared means the viewer holds no grant. Handlers MUST render it as 404,
// never 403: a 403 confirms the data exists and is being withheld, which leaks
// the existence of something the owner chose not to share.
var ErrNotShared = errors.New("access: not shared")
```

`api/internal/access/repository.go`:

```go
package access

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

// GrantedOwners returns the subset of `owners` that have granted `category` to
// a circle containing `viewer`.
//
// One query for the whole list, never one per owner: both cross-user endpoints
// fan out over every friend or group member, and a per-owner resolve would be
// an N+1 on the hot path.
func (r Repository) GrantedOwners(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, category Category) ([]uuid.UUID, error) {
	if len(owners) == 0 {
		return nil, nil
	}
	out := []uuid.UUID{}
	err := r.db.WithContext(ctx).
		Table("share_circles AS c").
		// DISTINCT because two circles may both grant the same category to the
		// same viewer; that is one permission, not two.
		Distinct("c.owner_id").
		Joins("JOIN share_circle_members m ON m.circle_id = c.id").
		Joins("JOIN share_grants g ON g.circle_id = c.id").
		Where("m.member_user_id = ? AND g.category = ? AND c.owner_id IN ?", viewer, string(category), owners).
		Pluck("c.owner_id", &out).Error
	if err != nil {
		return nil, fmt.Errorf("access: granted owners: %w", err)
	}
	return out, nil
}
```

`api/internal/access/service.go`:

```go
package access

import (
	"context"

	"github.com/google/uuid"
)

type Service struct {
	repo Repository
}

func NewService(repo Repository) Service { return Service{repo: repo} }

// Resolve returns a Grant, or ErrNotShared. It is the ONLY way to obtain a
// Grant with an owner in it.
func (s Service) Resolve(ctx context.Context, viewer, owner uuid.UUID, c Category) (Grant, error) {
	grants, err := s.ResolveMany(ctx, viewer, []uuid.UUID{owner}, c)
	if err != nil {
		return Grant{}, err
	}
	g, ok := grants[owner]
	if !ok {
		return Grant{}, ErrNotShared
	}
	return g, nil
}

// ResolveMany is the batch form, keyed by owner. Owners with no grant are
// ABSENT from the map rather than present with a zero Grant -- a zero Grant is
// indistinguishable from a forged one and must never appear to be a result.
func (s Service) ResolveMany(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, c Category) (map[uuid.UUID]Grant, error) {
	out := map[uuid.UUID]Grant{}
	// An unknown category is refused here rather than in SQL, so a typo can
	// never silently match nothing and read as "not shared".
	if !c.Valid() || len(owners) == 0 {
		return out, nil
	}
	granted, err := s.repo.GrantedOwners(ctx, viewer, owners, c)
	if err != nil {
		return nil, err
	}
	for _, owner := range granted {
		out[owner] = Grant{viewer: viewer, owner: owner, category: c}
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/access/ -p 1 -v`
Expected: PASS, 8 tests

- [ ] **Step 5: Mutation-check the resolver**

Temporarily change `Where("m.member_user_id = ? AND g.category = ? AND c.owner_id IN ?", ...)` to drop the `g.category = ?` term. Re-run. Expected: `TestResolveRefusesACategoryTheCircleWasNotGranted` FAILS. Restore the line.

Record the result in the commit message. A test that stays green under this mutation is asserting nothing.

- [ ] **Step 6: Commit**

```bash
git add api/internal/access/
git commit -m "feat(access): resolve per-circle, per-category grants (#326)"
```

---

### Task 4: Circle management — repository

**Files:**
- Create: `api/internal/share/model.go`
- Create: `api/internal/share/repository.go`
- Create: `api/internal/share/errors.go`
- Test: `api/internal/share/repository_test.go`

**Interfaces:**
- Consumes: tables from Task 1; `access.Category` (Task 2)
- Produces:
  - `share.Circle{ID, OwnerID, Name, CreatedAt}`
  - `share.CircleView{ID, Name, Members []share.MemberView, Categories []access.Category}`
  - `share.MemberView{ID, DisplayName}`
  - `share.NewRepository(db *gorm.DB) Repository`
  - `(Repository) Create(ctx, ownerID uuid.UUID, name string) (Circle, error)`
  - `(Repository) ListForOwner(ctx, ownerID uuid.UUID) ([]CircleView, error)`
  - `(Repository) FindByID(ctx, id uuid.UUID) (*Circle, error)`
  - `(Repository) AddMember(ctx, circleID, memberID uuid.UUID) error`
  - `(Repository) RemoveMember(ctx, circleID, memberID uuid.UUID) error`
  - `(Repository) SetCategories(ctx, circleID uuid.UUID, cats []access.Category) error`
  - `(Repository) Delete(ctx, circleID uuid.UUID) error`
  - `share.ErrDuplicateName`

- [ ] **Step 1: Write the failing test**

```go
package share

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable"
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
		`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`,
		id, id.String()+"@example.test", name).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

func TestCreateAndListCircle(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.Equal(t, "Household", c.Name)

	views, err := repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, views, 1)
	require.Empty(t, views[0].Members)
	require.Empty(t, views[0].Categories)
}

func TestCreateRejectsADuplicateNameForTheSameOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")

	_, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	// Case and surrounding whitespace do not make a different circle -- two
	// circles a user cannot tell apart are a settings screen they cannot use.
	_, err = repo.Create(context.Background(), owner, "  household  ")
	require.ErrorIs(t, err, ErrDuplicateName)
}

func TestTwoOwnersMayUseTheSameCircleName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	a := seedUser(t, db, "a")
	b := seedUser(t, db, "b")

	_, err := repo.Create(context.Background(), a, "Household")
	require.NoError(t, err)
	_, err = repo.Create(context.Background(), b, "Household")
	require.NoError(t, err)
}

func TestAddAndRemoveMember(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")
	friend := seedUser(t, db, "friend")
	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)

	require.NoError(t, repo.AddMember(context.Background(), c.ID, friend))
	views, err := repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, views[0].Members, 1)
	require.Equal(t, "friend", views[0].Members[0].DisplayName)

	require.NoError(t, repo.RemoveMember(context.Background(), c.ID, friend))
	views, err = repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Empty(t, views[0].Members)
}

func TestAddMemberTwiceIsNotAnError(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")
	friend := seedUser(t, db, "friend")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, repo.AddMember(context.Background(), c.ID, friend))
	require.NoError(t, repo.AddMember(context.Background(), c.ID, friend))
	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Len(t, views[0].Members, 1)
}

func TestSetCategoriesReplacesRatherThanAppends(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, repo.SetCategories(context.Background(), c.ID,
		[]access.Category{access.CategoryProgress, access.CategoryBody}))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID,
		[]access.Category{access.CategoryProgress}))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Equal(t, []access.Category{access.CategoryProgress}, views[0].Categories)
}

// Revoking everything must leave no grant behind -- the case a naive
// "insert the new set" implementation gets wrong.
func TestSetCategoriesToEmptyRevokesAll(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, repo.SetCategories(context.Background(), c.ID, []access.Category{access.CategoryBody}))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID, nil))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Empty(t, views[0].Categories)
}

func TestDeleteCircleRemovesMembersAndGrants(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "owner")
	friend := seedUser(t, db, "friend")
	c, _ := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, repo.AddMember(context.Background(), c.ID, friend))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID, []access.Category{access.CategoryBody}))

	require.NoError(t, repo.Delete(context.Background(), c.ID))

	var members, grants int64
	db.Raw(`SELECT count(*) FROM share_circle_members WHERE circle_id = ?`, c.ID).Scan(&members)
	db.Raw(`SELECT count(*) FROM share_grants WHERE circle_id = ?`, c.ID).Scan(&grants)
	require.Zero(t, members)
	require.Zero(t, grants)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -p 1 -v`
Expected: FAIL — `undefined: NewRepository`

- [ ] **Step 3: Write the implementation**

`api/internal/share/errors.go`:

```go
package share

import "errors"

var (
	// ErrDuplicateName is a circle name the owner already uses. Compared
	// case-insensitively and trimmed, matching share_circles_owner_name.
	ErrDuplicateName = errors.New("share: duplicate circle name")
	// ErrNotOwner is any attempt to modify a circle you do not own.
	ErrNotOwner = errors.New("share: not the circle owner")
	// ErrNotFriends is an attempt to add someone who is not an accepted friend.
	ErrNotFriends = errors.New("share: not friends")
)
```

`api/internal/share/model.go`:

```go
// Package share owns circles: named sets of friends an owner grants categories
// to (kora#326). It writes the grants; package access reads them.
package share

import (
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
)

type Circle struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	OwnerID   uuid.UUID `json:"owner_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func (Circle) TableName() string { return "share_circles" }

// MemberView never exposes email -- same projection rule as social.FriendView.
type MemberView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}

type CircleView struct {
	ID         uuid.UUID         `json:"id"`
	Name       string            `json:"name"`
	Members    []MemberView      `json:"members"`
	Categories []access.Category `json:"categories"`
}
```

`api/internal/share/repository.go`:

```go
package share

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, ownerID uuid.UUID, name string) (Circle, error) {
	c := Circle{OwnerID: ownerID, Name: strings.TrimSpace(name)}
	err := r.db.WithContext(ctx).Create(&c).Error
	if err != nil {
		// 23505 is the unique violation from share_circles_owner_name. Mapped
		// to a typed error so the handler can say "you already have a circle
		// called that" instead of a 500.
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return Circle{}, ErrDuplicateName
		}
		return Circle{}, fmt.Errorf("share: create circle: %w", err)
	}
	return c, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Circle, error) {
	var c Circle
	err := r.db.WithContext(ctx).First(&c, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("share: find circle: %w", err)
	}
	return &c, nil
}

func (r Repository) ListForOwner(ctx context.Context, ownerID uuid.UUID) ([]CircleView, error) {
	circles := []Circle{}
	if err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("created_at").
		Find(&circles).Error; err != nil {
		return nil, fmt.Errorf("share: list circles: %w", err)
	}

	views := make([]CircleView, 0, len(circles))
	for _, c := range circles {
		members := []MemberView{}
		if err := r.db.WithContext(ctx).
			Table("share_circle_members AS m").
			Select("u.id AS id, u.display_name AS display_name").
			Joins("JOIN users u ON u.id = m.member_user_id").
			Where("m.circle_id = ?", c.ID).
			Order("u.display_name").
			Scan(&members).Error; err != nil {
			return nil, fmt.Errorf("share: list members: %w", err)
		}

		cats := []access.Category{}
		if err := r.db.WithContext(ctx).
			Table("share_grants").
			Where("circle_id = ?", c.ID).
			Order("category").
			Pluck("category", &cats).Error; err != nil {
			return nil, fmt.Errorf("share: list grants: %w", err)
		}

		views = append(views, CircleView{ID: c.ID, Name: c.Name, Members: members, Categories: cats})
	}
	return views, nil
}

// AddMember is idempotent: adding someone already in the circle is a no-op, not
// an error, because the UI's "add" is a toggle and a double-tap is not a fault.
func (r Repository) AddMember(ctx context.Context, circleID, memberID uuid.UUID) error {
	err := r.db.WithContext(ctx).
		Exec(`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)
		      ON CONFLICT DO NOTHING`, circleID, memberID).Error
	if err != nil {
		return fmt.Errorf("share: add member: %w", err)
	}
	return nil
}

func (r Repository) RemoveMember(ctx context.Context, circleID, memberID uuid.UUID) error {
	err := r.db.WithContext(ctx).
		Exec(`DELETE FROM share_circle_members WHERE circle_id = ? AND member_user_id = ?`,
			circleID, memberID).Error
	if err != nil {
		return fmt.Errorf("share: remove member: %w", err)
	}
	return nil
}

// SetCategories REPLACES the circle's grants with exactly `cats`.
//
// Delete-then-insert inside one transaction, so revoking everything actually
// revokes -- an implementation that only inserts the new set would leave a
// revoked category granted, which is the worst direction for this bug to fail.
func (r Repository) SetCategories(ctx context.Context, circleID uuid.UUID, cats []access.Category) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`DELETE FROM share_grants WHERE circle_id = ?`, circleID).Error; err != nil {
			return fmt.Errorf("share: clear grants: %w", err)
		}
		for _, c := range cats {
			if err := tx.Exec(`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`,
				circleID, string(c)).Error; err != nil {
				return fmt.Errorf("share: insert grant: %w", err)
			}
		}
		return nil
	})
}

func (r Repository) Delete(ctx context.Context, circleID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Circle{}, "id = ?", circleID).Error; err != nil {
		return fmt.Errorf("share: delete circle: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -p 1 -v`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add api/internal/share/
git commit -m "feat(share): circle repository with replace-semantics grants (#326)"
```

---

### Task 5: Circle service — ownership and friendship rules

**Files:**
- Create: `api/internal/share/service.go`
- Test: `api/internal/share/service_test.go`

**Interfaces:**
- Consumes: `share.Repository` (Task 4), `social.Repository.AreFriends` (existing)
- Produces:
  - `share.NewService(repo Repository, friends friendSource) Service`
  - `(Service) Create(ctx, ownerID uuid.UUID, name string) (Circle, error)`
  - `(Service) List(ctx, ownerID uuid.UUID) ([]CircleView, error)`
  - `(Service) AddMember(ctx, ownerID, circleID, memberID uuid.UUID) error`
  - `(Service) RemoveMember(ctx, ownerID, circleID, memberID uuid.UUID) error`
  - `(Service) SetCategories(ctx, ownerID, circleID uuid.UUID, cats []access.Category) error`
  - `(Service) Delete(ctx, ownerID, circleID uuid.UUID) error`
  - `(Service) Leave(ctx, memberID, circleID uuid.UUID) error`

- [ ] **Step 1: Write the failing test**

```go
package share

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
)

type stubFriends struct{ areFriends bool }

func (s stubFriends) AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error) {
	return s.areFriends, nil
}

func TestAddMemberRefusesANonFriend(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: false})
	owner := seedUser(t, db, "owner")
	stranger := seedUser(t, db, "stranger")
	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)

	err = svc.AddMember(context.Background(), owner, c.ID, stranger)
	require.ErrorIs(t, err, ErrNotFriends)
}

func TestAddMemberAcceptsAFriend(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	friend := seedUser(t, db, "friend")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, svc.AddMember(context.Background(), owner, c.ID, friend))
}

// Every mutation is owner-gated. Without this, knowing a circle UUID would be
// enough to grant yourself access to its owner's data.
func TestMutationsRefuseANonOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	attacker := seedUser(t, db, "attacker")
	victimCircle, _ := repo.Create(context.Background(), owner, "Household")

	require.ErrorIs(t, svc.AddMember(context.Background(), attacker, victimCircle.ID, attacker), ErrNotOwner)
	require.ErrorIs(t, svc.RemoveMember(context.Background(), attacker, victimCircle.ID, owner), ErrNotOwner)
	require.ErrorIs(t, svc.SetCategories(context.Background(), attacker, victimCircle.ID,
		[]access.Category{access.CategoryBody}), ErrNotOwner)
	require.ErrorIs(t, svc.Delete(context.Background(), attacker, victimCircle.ID), ErrNotOwner)
}

func TestSetCategoriesRefusesAnUnknownCategory(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	err := svc.SetCategories(context.Background(), owner, c.ID, []access.Category{"recipes"})
	require.Error(t, err)
}

// A member may remove themselves. Being shared with carries an implicit
// relationship and possibly notifications, and is not always welcome.
func TestAMemberMayLeaveACircleTheyDoNotOwn(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	member := seedUser(t, db, "member")
	c, _ := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	require.NoError(t, svc.Leave(context.Background(), member, c.ID))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Empty(t, views[0].Members)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -run 'TestAddMember|TestMutations|TestSetCategoriesRefuses|TestAMember' -p 1 -v`
Expected: FAIL — `undefined: NewService`

- [ ] **Step 3: Write the implementation**

```go
package share

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
)

// friendSource is the slice of social.Repository this package needs. Declared
// here rather than imported so the dependency is one method wide.
type friendSource interface {
	AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error)
}

type Service struct {
	repo    Repository
	friends friendSource
}

func NewService(repo Repository, friends friendSource) Service {
	return Service{repo: repo, friends: friends}
}

func (s Service) Create(ctx context.Context, ownerID uuid.UUID, name string) (Circle, error) {
	if len(name) == 0 || len(name) > 60 {
		return Circle{}, httpx.ValidationError{Message: "Circle name must be 1-60 characters."}
	}
	return s.repo.Create(ctx, ownerID, name)
}

func (s Service) List(ctx context.Context, ownerID uuid.UUID) ([]CircleView, error) {
	return s.repo.ListForOwner(ctx, ownerID)
}

// ownedCircle is the gate on every mutation: knowing a circle's UUID must not
// be enough to modify it.
func (s Service) ownedCircle(ctx context.Context, ownerID, circleID uuid.UUID) error {
	c, err := s.repo.FindByID(ctx, circleID)
	if err != nil {
		return err
	}
	if c == nil || c.OwnerID != ownerID {
		return ErrNotOwner
	}
	return nil
}

func (s Service) AddMember(ctx context.Context, ownerID, circleID, memberID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	// A circle is not a second way to know someone -- membership stays inside
	// the friendship graph, so #153's discovery remains the only edge.
	friends, err := s.friends.AreFriends(ctx, ownerID, memberID)
	if err != nil {
		return fmt.Errorf("share: check friendship: %w", err)
	}
	if !friends {
		return ErrNotFriends
	}
	return s.repo.AddMember(ctx, circleID, memberID)
}

func (s Service) RemoveMember(ctx context.Context, ownerID, circleID, memberID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	return s.repo.RemoveMember(ctx, circleID, memberID)
}

func (s Service) SetCategories(ctx context.Context, ownerID, circleID uuid.UUID, cats []access.Category) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	for _, c := range cats {
		if !c.Valid() {
			return httpx.ValidationError{Message: fmt.Sprintf("Unknown sharing category: %s", c)}
		}
	}
	return s.repo.SetCategories(ctx, circleID, cats)
}

func (s Service) Delete(ctx context.Context, ownerID, circleID uuid.UUID) error {
	if err := s.ownedCircle(ctx, ownerID, circleID); err != nil {
		return err
	}
	return s.repo.Delete(ctx, circleID)
}

// Leave removes the CALLER from a circle they do not own. Deliberately not
// owner-gated -- that is the whole point of it.
func (s Service) Leave(ctx context.Context, memberID, circleID uuid.UUID) error {
	return s.repo.RemoveMember(ctx, circleID, memberID)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -p 1 -v`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add api/internal/share/service.go api/internal/share/service_test.go
git commit -m "feat(share): owner-gated circle mutations, friends-only membership (#326)"
```

---

### Task 6: Circle HTTP handlers and routes

**Files:**
- Create: `api/internal/share/handler.go`
- Test: `api/internal/share/handler_test.go`
- Modify: `api/internal/server/router.go` (add routes beside the existing `/friends` block, around line 343)

**Interfaces:**
- Consumes: `share.Service` (Task 5)
- Produces: routes
  - `GET /v1/share/circles`
  - `POST /v1/share/circles`
  - `DELETE /v1/share/circles/:id`
  - `POST /v1/share/circles/:id/members`
  - `DELETE /v1/share/circles/:id/members/:userId`
  - `PUT /v1/share/circles/:id/categories`
  - `POST /v1/share/circles/:id/leave`

- [ ] **Step 1: Write the failing test**

```go
package share

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func testRouter(t *testing.T, db *gorm.DB, userID uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(NewService(NewRepository(db), stubFriends{areFriends: true}))
	g := r.Group("/v1", func(c *gin.Context) { c.Set("user_id", userID.String()) })
	g.GET("/share/circles", h.List)
	g.POST("/share/circles", h.Create)
	g.PUT("/share/circles/:id/categories", h.SetCategories)
	return r
}

func TestCreateCircleReturnsIt(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	r := testRouter(t, db, owner)

	body, _ := json.Marshal(map[string]string{"name": "Household"})
	req := httptest.NewRequest(http.MethodPost, "/v1/share/circles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusCreated, w.Code)
	require.Contains(t, w.Body.String(), "Household")
}

func TestCreateCircleRejectsABlankName(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	r := testRouter(t, db, owner)

	body, _ := json.Marshal(map[string]string{"name": ""})
	req := httptest.NewRequest(http.MethodPost, "/v1/share/circles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
}

// Modifying someone else's circle must not report 403 -- that confirms the
// circle exists. Same rule as ErrNotShared: not-yours and not-there are
// indistinguishable.
func TestModifyingAnotherOwnersCircleIs404(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	attacker := seedUser(t, db, "attacker")
	victim, err := NewRepository(db).Create(t.Context(), owner, "Household")
	require.NoError(t, err)

	r := testRouter(t, db, attacker)
	body, _ := json.Marshal(map[string][]string{"categories": {"body"}})
	req := httptest.NewRequest(http.MethodPut, "/v1/share/circles/"+victim.ID.String()+"/categories",
		bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -run TestCreateCircle -p 1 -v`
Expected: FAIL — `undefined: NewHandler`

- [ ] **Step 3: Write the handler**

```go
package share

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
)

type Handler struct {
	svc Service
}

func NewHandler(svc Service) Handler { return Handler{svc: svc} }

func callerID(c *gin.Context) (uuid.UUID, bool) {
	raw, ok := c.Get("user_id")
	if !ok {
		return uuid.Nil, false
	}
	s, ok := raw.(string)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(s)
	return id, err == nil
}

// respond maps service errors to status codes. ErrNotOwner is 404 on purpose:
// a 403 would confirm the circle exists.
func respond(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrNotOwner):
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
	case errors.Is(err, ErrNotFriends):
		httpx.Error(c, http.StatusBadRequest, "not_friends", "You can only add friends to a circle.")
	case errors.Is(err, ErrDuplicateName):
		httpx.Error(c, http.StatusConflict, "duplicate_name", "You already have a circle with that name.")
	default:
		httpx.RespondServiceError(c, err)
	}
}

func (h Handler) List(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	views, err := h.svc.List(c.Request.Context(), id)
	if err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, views)
}

func (h Handler) Create(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Give the circle a name.")
		return
	}
	circle, err := h.svc.Create(c.Request.Context(), id, req.Name)
	if err != nil {
		respond(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": circle})
}

func (h Handler) SetCategories(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	var req struct {
		Categories []access.Category `json:"categories"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Send a list of categories.")
		return
	}
	if err := h.svc.SetCategories(c.Request.Context(), id, circleID, req.Categories); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"categories": req.Categories})
}

func (h Handler) AddMember(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	var req struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_body", "Send the friend's user_id.")
		return
	}
	if err := h.svc.AddMember(c.Request.Context(), id, circleID, req.UserID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h Handler) RemoveMember(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	memberID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Member not found.")
		return
	}
	if err := h.svc.RemoveMember(c.Request.Context(), id, circleID, memberID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h Handler) Delete(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	if err := h.svc.Delete(c.Request.Context(), id, circleID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

func (h Handler) Leave(c *gin.Context) {
	id, ok := callerID(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "Sign in to continue.")
		return
	}
	circleID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "Circle not found.")
		return
	}
	if err := h.svc.Leave(c.Request.Context(), id, circleID); err != nil {
		respond(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}
```

- [ ] **Step 4: Wire the routes**

In `api/internal/server/router.go`, immediately after the existing `v1.GET("/friends/code", socialHandler.Code)` line:

```go
		shareHandler := share.NewHandler(share.NewService(share.NewRepository(deps.DB), socialRepo))
		v1.GET("/share/circles", shareHandler.List)
		v1.POST("/share/circles", shareHandler.Create)
		v1.DELETE("/share/circles/:id", shareHandler.Delete)
		v1.POST("/share/circles/:id/members", shareHandler.AddMember)
		v1.DELETE("/share/circles/:id/members/:userId", shareHandler.RemoveMember)
		v1.PUT("/share/circles/:id/categories", shareHandler.SetCategories)
		v1.POST("/share/circles/:id/leave", shareHandler.Leave)
```

Add `"github.com/tesserix/kora/api/internal/share"` to the import block.

- [ ] **Step 5: Run tests and build**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/share/ -p 1 -v && go build ./...`
Expected: PASS, then a clean build.

- [ ] **Step 6: Commit**

```bash
git add api/internal/share/handler.go api/internal/share/handler_test.go api/internal/server/router.go
git commit -m "feat(share): circle endpoints, not-yours renders as 404 (#326)"
```

---

### Task 7: Adopt the gateway in the two shipped cross-user reads

**Files:**
- Modify: `api/internal/compare/service.go:35-77`
- Modify: `api/internal/compare/handler.go`
- Modify: `api/internal/groups/handler.go:188`
- Modify: `api/internal/groups/repository.go:134`
- Modify: `api/internal/social/repository.go:133-140` (drop `ShareProgress` from `CompareRow`)
- Test: `api/internal/compare/service_test.go`

**Interfaces:**
- Consumes: `access.Service.ResolveMany` (Task 3)
- Produces: `compare.Member` without `ShareProgress`; `compare.Service.ProgressForMembers(ctx, day, loc, members, grants map[uuid.UUID]access.Grant)`

- [ ] **Step 1: Write the failing test**

```go
package compare

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
)

// THE invariant for this task: a member with no grant gets no metrics, and the
// pointers stay nil so they serialize away. Replaces the old ShareProgress
// bool with the same behaviour driven by a resolved grant.
func TestMemberWithoutAGrantGetsNoMetrics(t *testing.T) {
	svc := NewService(nil, nil, stubLogs{})
	member := Member{ID: uuid.New(), DisplayName: "friend", TargetKcal: 2000}

	out, err := svc.ProgressForMembers(context.Background(), time.Now(), time.UTC,
		[]Member{member}, map[uuid.UUID]access.Grant{})

	require.NoError(t, err)
	require.Len(t, out, 1)
	require.False(t, out[0].Sharing)
	require.Nil(t, out[0].StreakDays)
	require.Nil(t, out[0].AdherenceDays)
}
```

Note: `stubLogs` must satisfy `progress.LogSource`. Copy the existing stub from `api/internal/compare/service_test.go` if one is present; if not, write one returning empty results for every method on that interface.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./api/internal/compare/ -run TestMemberWithoutAGrant -v`
Expected: FAIL — `too many arguments in call to svc.ProgressForMembers`

- [ ] **Step 3: Change the signature and the gate**

In `api/internal/compare/service.go`, remove `ShareProgress` from `Member`, and change:

```go
// ProgressForMembers is the single consent gate: a member's metrics are
// computed ONLY when a resolved grant is present for them; otherwise the metric
// pointers stay nil and serialize away (omitempty).
//
// The grant map comes from access.ResolveMany -- one query for the whole list,
// never one per member, because this path fans out over every friend or group
// member (kora#326).
func (s Service) ProgressForMembers(ctx context.Context, day time.Time, loc *time.Location,
	members []Member, grants map[uuid.UUID]access.Grant) ([]FriendProgress, error) {
	out := make([]FriendProgress, 0, len(members))
	for _, m := range members {
		_, shared := grants[m.ID]
		fp := FriendProgress{ID: m.ID, DisplayName: m.DisplayName, Sharing: shared}
		if shared {
			// ... existing metric computation, unchanged ...
		}
		out = append(out, fp)
	}
	return out, nil
}
```

Keep the body of the metric computation exactly as it is; only the gate changes.

- [ ] **Step 4: Update the two callers**

In `api/internal/compare/handler.go` and `api/internal/groups/handler.go:188`, resolve grants before calling:

```go
	grants, err := h.accessSvc.ResolveMany(c.Request.Context(), callerID, ownerIDs, access.CategoryProgress)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
```

Remove `ShareProgress: r.ShareProgress` from the `compare.Member` construction in `groups/handler.go:188`, and drop `u.share_progress AS share_progress` from the `Select` in `groups/repository.go:134`. Remove the `ShareProgress` field from `groups.model.go:50` and from `social.CompareRow`.

- [ ] **Step 5: Run the full API suite**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/... -p 1`
Expected: PASS. Any test still referencing `ShareProgress` must be updated to pass a grant map instead — the behaviour it asserts is unchanged.

- [ ] **Step 6: Commit**

```bash
git add api/internal/compare/ api/internal/groups/ api/internal/social/repository.go
git commit -m "refactor(compare): gate shared progress on a resolved grant, not a global flag (#326)"
```

---

### Task 8: Migrate off `share_progress` and document the challenges exception

**Files:**
- Create: `api/internal/database/migrations/000055_drop_share_progress.up.sql`
- Create: `api/internal/database/migrations/000055_drop_share_progress.down.sql`
- Modify: `api/internal/user/model.go:23`, `api/internal/user/handler.go:43-57`, `api/internal/user/repository.go:135`
- Modify: `api/internal/server/router.go:178` (remove the `/me/share-progress` route)
- Modify: `api/internal/challenges/service.go:153` (comment only)

**Interfaces:**
- Consumes: everything above
- Produces: `users.share_progress` gone; `PATCH /v1/me/share-progress` gone

- [ ] **Step 1: Write the up migration**

```sql
-- Backfill circles from the boolean this replaces (kora#326), then drop it.
--
-- share_progress = true meant "every accepted friend may see my progress", so
-- the equivalent circle is one named "Friends" holding exactly those friends,
-- granted `progress`. false meant nothing was shared and writes no rows -- the
-- new default is deny, same as the old one.
--
-- This is cheap because Kora is PRE-LAUNCH with one real account. Against a
-- live user base, silently reconstructing everyone's sharing from a boolean
-- would deserve materially more care than this.
INSERT INTO share_circles (id, owner_id, name)
SELECT gen_random_uuid(), u.id, 'Friends'
FROM users u
WHERE u.share_progress = true;

INSERT INTO share_circle_members (circle_id, member_user_id)
SELECT c.id,
       CASE WHEN f.requester_id = c.owner_id THEN f.addressee_id ELSE f.requester_id END
FROM share_circles c
JOIN friendships f
  ON (f.requester_id = c.owner_id OR f.addressee_id = c.owner_id)
 AND f.status = 'accepted'
WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

INSERT INTO share_grants (circle_id, category)
SELECT c.id, 'progress' FROM share_circles c WHERE c.name = 'Friends'
ON CONFLICT DO NOTHING;

ALTER TABLE users DROP COLUMN share_progress;
```

Note: confirm the friendships table name and column names against `api/internal/social/model.go` before running — the model declares `Friendship` with `RequesterID`/`AddresseeID`, and GORM's default table name is `friendships`.

- [ ] **Step 2: Write the down migration**

```sql
ALTER TABLE users ADD COLUMN share_progress BOOLEAN NOT NULL DEFAULT false;

UPDATE users SET share_progress = true
WHERE id IN (
    SELECT c.owner_id FROM share_circles c
    JOIN share_grants g ON g.circle_id = c.id AND g.category = 'progress'
);
```

- [ ] **Step 3: Remove the Go surface**

Delete `ShareProgress` from `user.User` (model.go:23), delete `UpdateShareProgress` (handler.go:46-57) and its request struct field (handler.go:43), delete `SetShareProgress` (repository.go:135), and delete the route at router.go:178.

- [ ] **Step 4: Document the challenges exception**

In `api/internal/challenges/service.go`, above `standingsFor`:

```go
// standingsFor scores every participant and ranks them (score desc, name asc).
//
// It deliberately does NOT consult share_grants (kora#326). Joining a challenge
// IS the consent here: ListParticipantsForScoring reads only
// challenge_participants, so a score can only appear for someone who chose to
// join. A challenge is a deliberate, scoped, visible act with an end date,
// which is a different thing from ambient sharing.
//
// This is the second consent mechanism in the codebase and that is intentional.
// Do not "unify" it into access.Resolve: doing so would empty existing
// leaderboards until every participant also built a circle, which reads as
// broken rather than private.
```

- [ ] **Step 5: Run everything**

Run: `go build ./... && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/... -p 1`
Expected: build clean, all tests pass, no references to `share_progress` remain (`grep -rn "share_progress\|ShareProgress" api/ --include="*.go"` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add api/internal/database/migrations/000055_drop_share_progress.up.sql api/internal/database/migrations/000055_drop_share_progress.down.sql api/internal/user/ api/internal/server/router.go api/internal/challenges/service.go
git commit -m "refactor(share): migrate share_progress into circles and drop it (#326)"
```

---

### Task 9: The forgot-the-gateway regression test

**Files:**
- Create: `api/internal/access/enforcement_test.go`

**Interfaces:**
- Consumes: the routes from Tasks 6 and 7
- Produces: nothing; this is the test that catches a future endpoint skipping the gateway

- [ ] **Step 1: Write the test**

```go
package access_test

// The invariant the whole design rests on: a viewer holding NO grant gets
// nothing from EVERY cross-user path. Asserted per PATH rather than per
// resolver, so an endpoint added later that forgets access.Resolve fails a test
// that already exists rather than needing someone to remember to write one.
//
// When a new cross-user endpoint is added, add it to crossUserPaths. That is
// the one manual step, and it is far smaller than remembering the whole rule.
var crossUserPaths = []struct {
	name   string
	method string
	path   string
}{
	{"friends progress", "GET", "/v1/friends/progress"},
	{"group progress", "GET", "/v1/groups/%s/progress"},
}
```

Then the test itself:

```go
func TestCrossUserPathsLeakNothingWithoutAGrant(t *testing.T) {
	db := testDB(t)
	viewer := seedUser(t, db, "viewer")
	owner := seedUser(t, db, "owner")
	// Friends, deliberately: friendship alone must not grant visibility.
	require.NoError(t, db.Exec(
		`INSERT INTO friendships (id, requester_id, addressee_id, status)
		 VALUES (gen_random_uuid(), ?, ?, 'accepted')`, viewer, owner).Error)
	groupID := seedGroupWithMembers(t, db, owner, []uuid.UUID{viewer, owner})

	for _, p := range crossUserPaths {
		t.Run(p.name, func(t *testing.T) {
			path := p.path
			if strings.Contains(path, "%s") {
				path = fmt.Sprintf(path, groupID)
			}
			r := testAPIRouter(t, db, viewer)
			req := httptest.NewRequest(p.method, path, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			require.Equal(t, http.StatusOK, w.Code)
			body := w.Body.String()
			// The owner may be LISTED -- membership is not secret -- but none of
			// their figures may appear. omitempty drops nil metric pointers, so
			// their absence from the JSON is the assertion.
			require.NotContains(t, body, `"streak_days"`)
			require.NotContains(t, body, `"adherence_days"`)
			require.Contains(t, body, `"sharing":false`)
		})
	}
}
```

`seedGroupWithMembers` and `testAPIRouter` are helpers this test file must
define: the first inserts a row into `groups` plus one `group_members` row per
user; the second builds a `gin.Engine` with the real `/v1/friends/progress` and
`/v1/groups/:id/progress` routes wired exactly as `router.go` wires them, with a
middleware setting `user_id` to the given viewer. Copy the route wiring verbatim
from `api/internal/server/router.go` rather than re-deriving it — a router that
differs from production is a test that proves nothing about production.

- [ ] **Step 2: Run it to verify it passes against the implementation**

Run: `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:5433/kora?sslmode=disable' go test ./api/internal/access/ -run TestCrossUser -p 1 -v`
Expected: PASS

- [ ] **Step 3: Mutation-check it**

Temporarily make `ResolveMany` return a grant for every requested owner. Re-run. Expected: FAIL on both paths. Restore.

If it passes under that mutation, the test is asserting nothing and must be rewritten before the task is complete.

- [ ] **Step 4: Commit**

```bash
git add api/internal/access/enforcement_test.go
git commit -m "test(access): pin that no cross-user path leaks without a grant (#326)"
```

---

## Deferred to a follow-up plan

The spec's client surfaces are not in this plan and need their own:

- The Circles settings screen
- The named-people confirmation on granting `body`
- The per-category audit view
- Client cache invalidation on a 404 from a previously-readable path
- Adopting `access.CategoryBody` in the body-composition read paths — no cross-user body endpoint exists yet, so the category is defined and enforced but not yet consumed

Also carried by the spec but belonging to a different issue:

- **#24's export must return your own data only.** Another person's metrics that
  you could read are not yours to export; an export including them would convert
  a revocable read grant into a permanent copy. There is no task for it here
  because there is no export code in this plan's scope — it is a constraint to
  apply when #24 is built, and it is recorded on that issue.

**This ordering is deliberate.** The category exists in the model and the gateway from Task 2, so the client work has something real to build against; but shipping a `body` toggle before a `body` read path exists would be a setting that claims to do something and does nothing — the failure mode the spec rejects.
