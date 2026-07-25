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
