package notifications

import (
	"context"
	"os"
	"testing"
	"time"

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
