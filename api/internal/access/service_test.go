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
		`INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)`,
		id, "access-"+id.String(), id.String()+"@example.test", name).Error)
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

// This is the end-to-end assertion: an unknown category never resolves,
// through the real Postgres path. It does NOT isolate why -- share_grants has
// a CHECK constraint restricting category to ('progress', 'body') (migration
// 000054), so no row can ever match category = 'recipes' even if the Go-level
// Category.Valid() guard in ResolveMany were deleted. That guard is pinned
// separately, without a database, by TestResolveManyRefusesAnUnknownCategoryWithoutQueryingTheRepository below.
func TestResolveRefusesAnUnknownCategory(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	owner := seedUser(t, db, "owner")
	viewer := seedUser(t, db, "viewer")
	seedCircle(t, db, owner, "Household", []uuid.UUID{viewer}, []Category{CategoryBody, CategoryProgress})

	_, err := svc.Resolve(context.Background(), viewer, owner, Category("recipes"))
	require.ErrorIs(t, err, ErrNotShared)
}

// alwaysGrants is a fake granter that reports every requested owner as
// granted, for any category, no matter what. It stands in for "the DB layer
// offers no protection at all" so this test isolates the Go-level
// Category.Valid() guard in ResolveMany, which the CHECK constraint on
// share_grants.category makes impossible to observe through a real database
// (see the comment on TestResolveRefusesAnUnknownCategory above).
type alwaysGrants struct {
	called bool
}

func (a *alwaysGrants) GrantedOwners(_ context.Context, _ uuid.UUID, owners []uuid.UUID, _ Category) ([]uuid.UUID, error) {
	a.called = true
	return owners, nil
}

func TestResolveManyRefusesAnUnknownCategoryWithoutQueryingTheRepository(t *testing.T) {
	fake := &alwaysGrants{}
	svc := NewService(fake)
	owner := uuid.New()
	viewer := uuid.New()

	got, err := svc.ResolveMany(context.Background(), viewer, []uuid.UUID{owner}, Category("recipes"))
	require.NoError(t, err)
	require.Empty(t, got)
	require.False(t, fake.called, "an unknown category must be refused before the repository is ever consulted")
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

// The cross-circle bleed this package exists to prevent: one owner runs two
// circles granting DIFFERENT categories, and the viewer belongs to only one
// of them. Membership in the "Family" circle must not leak the category only
// "Gym" grants -- resolution has to be scoped per-circle, not per-owner.
func TestResolveScopesTheGrantToTheCircleTheViewerBelongsTo(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	viewer := seedUser(t, db, "viewer")
	owner := seedUser(t, db, "owner")
	seedCircle(t, db, owner, "Family", []uuid.UUID{viewer}, []Category{CategoryBody})
	seedCircle(t, db, owner, "Gym", nil, []Category{CategoryProgress})

	g, err := svc.Resolve(context.Background(), viewer, owner, CategoryBody)
	require.NoError(t, err)
	require.Equal(t, owner, g.Owner())

	_, err = svc.Resolve(context.Background(), viewer, owner, CategoryProgress)
	require.ErrorIs(t, err, ErrNotShared)
}

func TestResolveManyWithNoOwnersDoesNotQuery(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db))
	viewer := seedUser(t, db, "viewer")

	got, err := svc.ResolveMany(context.Background(), viewer, nil, CategoryProgress)
	require.NoError(t, err)
	require.Empty(t, got)
}
