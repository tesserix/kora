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
