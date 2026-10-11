package share

import (
	"context"
	"encoding/json"
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
		`INSERT INTO users (id, firebase_uid, email, display_name) VALUES (?, ?, ?, ?)`,
		id, "share-"+id.String(), id.String()+"@example.test", name).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM users WHERE id = ?`, id) })
	return id
}

func TestCreateAndListCircle(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
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
	repo := NewRepository(db, func(string) string { return "" })
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
	repo := NewRepository(db, func(string) string { return "" })
	a := seedUser(t, db, "a")
	b := seedUser(t, db, "b")

	_, err := repo.Create(context.Background(), a, "Household")
	require.NoError(t, err)
	_, err = repo.Create(context.Background(), b, "Household")
	require.NoError(t, err)
}

func TestAddAndRemoveMember(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
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
	repo := NewRepository(db, func(string) string { return "" })
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
	repo := NewRepository(db, func(string) string { return "" })
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, repo.SetCategories(context.Background(), c.ID,
		[]access.Category{access.CategoryProgress, access.CategoryBody}))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID,
		[]access.Category{access.CategoryProgress}))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Equal(t, []access.Category{access.CategoryProgress}, views[0].Categories)
}

// TestSetCategoriesDedupesDuplicateCategories pins the fix for
// {"categories":["progress","progress"]}: (circle_id, category) is the
// share_grants primary key, so inserting an un-deduped list previously
// tripped an unmapped 23505 unique violation -> 500.
func TestSetCategoriesDedupesDuplicateCategories(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	err := repo.SetCategories(context.Background(), c.ID,
		[]access.Category{access.CategoryProgress, access.CategoryProgress})
	require.NoError(t, err)

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Equal(t, []access.Category{access.CategoryProgress}, views[0].Categories)
}

// Revoking everything must leave no grant behind -- the case a naive
// "insert the new set" implementation gets wrong.
func TestSetCategoriesToEmptyRevokesAll(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, repo.SetCategories(context.Background(), c.ID, []access.Category{access.CategoryBody}))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID, nil))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Empty(t, views[0].Categories)
}

func TestDeleteCircleRemovesMembersAndGrants(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
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

func TestListMembers_CarriesAvatarURLButNeverEmail(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	path := "avatars/" + member.String() + "/v1.jpg"
	require.NoError(t, db.Exec(
		`UPDATE users SET avatar_path = ? WHERE id = ?`, path, member).Error)

	repo := NewRepository(db, func(p string) string {
		if p == "" {
			return ""
		}
		return "https://assets.test/" + p
	})
	circle, err := repo.Create(context.Background(), owner, "Close")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), circle.ID, member))

	circles, err := repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, circles, 1)
	require.Len(t, circles[0].Members, 1)
	require.Equal(t, "https://assets.test/"+path, circles[0].Members[0].AvatarURL)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, member).Scan(&email).Error)
	body, err := json.Marshal(circles)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
}
