package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/identity"
	"github.com/tesserix/kora/api/internal/user"
)

// These are the real-database proof for kora#453's SQL half: how each of
// FriendStatusProvider's four external values is computed from an actual
// friendships row. TestLookup_ReportsEachWiredStatusValue in
// internal/identity proves the PASS-THROUGH from a fake; this file proves
// what the fake stands in for.

func TestFriendshipStatus_NoneWhenNoRelationship(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	a, b := seedUser(t, db, "A"), seedUser(t, db, "B")

	status, err := svc.FriendshipStatus(context.Background(), a, b)
	require.NoError(t, err)
	require.Equal(t, identity.FriendshipNone, status)
}

func TestFriendshipStatus_RequestSentWhenViewerIsTheRequester(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	a, b := seedUser(t, db, "A"), seedUser(t, db, "B")

	// Written directly, not through SendRequest, so this test is about
	// FriendshipStatus reading a pending row -- not about SendRequest's own
	// input validation.
	_, err := NewRepository(db).Create(context.Background(),
		Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)

	status, err := svc.FriendshipStatus(context.Background(), a, b)
	require.NoError(t, err)
	require.Equal(t, identity.FriendshipRequestSent, status,
		"the requester looking up the addressee must see their own pending send")
}

func TestFriendshipStatus_RequestReceivedWhenViewerIsTheAddressee(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	a, b := seedUser(t, db, "A"), seedUser(t, db, "B")

	_, err := NewRepository(db).Create(context.Background(),
		Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)

	// b is the addressee, so from b's viewpoint looking a up, a already sent
	// a request TO them -- the "Respond" state, not "Requested".
	status, err := svc.FriendshipStatus(context.Background(), b, a)
	require.NoError(t, err)
	require.Equal(t, identity.FriendshipRequestReceived, status)
}

func TestFriendshipStatus_FriendsWhenAccepted(t *testing.T) {
	db := testDB(t)
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	a, b := seedUser(t, db, "A"), seedUser(t, db, "B")

	f, err := NewRepository(db).Create(context.Background(),
		Friendship{RequesterID: a, AddresseeID: b, Status: FriendStatusPending})
	require.NoError(t, err)
	require.NoError(t, NewRepository(db).UpdateStatus(context.Background(), f.ID, FriendStatusAccepted))

	// Symmetric: either party looking the other up sees "friends".
	status, err := svc.FriendshipStatus(context.Background(), a, b)
	require.NoError(t, err)
	require.Equal(t, identity.FriendshipFriends, status)

	status, err = svc.FriendshipStatus(context.Background(), b, a)
	require.NoError(t, err)
	require.Equal(t, identity.FriendshipFriends, status)
}
