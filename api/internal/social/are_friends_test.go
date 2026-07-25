package social

import (
	"context"
	"testing"

	"github.com/google/uuid"
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

func mustPairID(t *testing.T, repo Repository, a, b uuid.UUID) uuid.UUID {
	f, err := repo.FindByPair(context.Background(), a, b)
	require.NoError(t, err)
	require.NotNil(t, f)
	return f.ID
}
