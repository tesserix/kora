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
