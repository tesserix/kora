package identity

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// fakeFriendshipProvider stands in for social.Service. It records the
// viewer/other pair it was called with, which is the only way to prove
// Lookup passed the ACTUAL viewer and the ACTUAL looked-up person's id,
// not swapped or zero-valued.
type fakeFriendshipProvider struct {
	status     FriendshipStatus
	err        error
	calls      int
	lastViewer uuid.UUID
	lastOther  uuid.UUID
}

func (f *fakeFriendshipProvider) FriendshipStatus(_ context.Context, viewerID, otherID uuid.UUID) (FriendshipStatus, error) {
	f.calls++
	f.lastViewer = viewerID
	f.lastOther = otherID
	return f.status, f.err
}

// TestLookup_NilFriendshipProviderDegradesToNone is the nil-tolerance
// requirement from kora#453: a Service built with newSvc/NewService/
// NewServiceWithAssets and no WithFriendships call must not panic, and must
// answer "none" rather than claim a relationship it cannot know about. Same
// treatment the nil Apple client and nil ObjectDeleter get in
// internal/user/deletion.go.
func TestLookup_NilFriendshipProviderDegradesToNone(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db) // no WithFriendships -- friendships field is its zero value, nil
	id := seedUser(t, db)
	retireCleanup(t, db, "nilprovider")

	_, err := svc.Claim(context.Background(), id, "nilprovider")
	require.NoError(t, err)

	require.NotPanics(t, func() {
		got, err := svc.Lookup(context.Background(), uuid.New(), "nilprovider")
		require.NoError(t, err)
		require.Equal(t, FriendshipNone, got.FriendshipStatus)
	})
}

// TestLookup_ErroringProviderDegradesToNone: a friendship-status lookup
// failing must not turn a successful handle lookup into an error -- the
// worst outcome of getting this field wrong is a stale button, not a lost
// answer to "who is this".
func TestLookup_ErroringProviderDegradesToNone(t *testing.T) {
	db := testDB(t)
	fake := &fakeFriendshipProvider{err: errors.New("social: friendship status lookup exploded")}
	svc := newSvc(db).WithFriendships(fake)
	id := seedUser(t, db)
	retireCleanup(t, db, "erroringprovider")

	_, err := svc.Claim(context.Background(), id, "erroringprovider")
	require.NoError(t, err)

	got, err := svc.Lookup(context.Background(), uuid.New(), "erroringprovider")
	require.NoError(t, err, "Lookup itself must still succeed")
	require.Equal(t, FriendshipNone, got.FriendshipStatus)
	require.Equal(t, 1, fake.calls, "the provider must have been consulted")
}

// TestLookup_ReportsEachWiredStatusValue is the "real database" proof for
// the WIRING half of kora#453: identity.Service.Lookup must pass the field
// straight through from FriendshipStatusProvider, for every one of the four
// external values a client switches on. (social.Service.FriendshipStatus's
// own real-database coverage of how each value gets computed from a
// Friendship row lives in internal/social, which can import internal/identity
// -- identity cannot import social back, so this package can only prove the
// PASS-THROUGH, via a fake, not the SQL underneath it.)
func TestLookup_ReportsEachWiredStatusValue(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	retireCleanup(t, db, "statuspassthrough")
	_, err := newSvc(db).Claim(context.Background(), id, "statuspassthrough")
	require.NoError(t, err)
	viewer := uuid.New()

	for _, status := range []FriendshipStatus{
		FriendshipNone, FriendshipRequestSent, FriendshipRequestReceived, FriendshipFriends,
	} {
		t.Run(string(status), func(t *testing.T) {
			fake := &fakeFriendshipProvider{status: status}
			svc := newSvc(db).WithFriendships(fake)

			got, err := svc.Lookup(context.Background(), viewer, "statuspassthrough")
			require.NoError(t, err)
			require.Equal(t, status, got.FriendshipStatus)
			require.Equal(t, viewer, fake.lastViewer, "the viewer id must be the caller's, not the looked-up person's")
			require.Equal(t, id, fake.lastOther, "the other id must be the person Lookup resolved, not the viewer")
		})
	}
}

// TestLookup_SelfNeverConsultsTheProvider: looking your own handle up must
// answer FriendshipSelf without a DB round trip through the provider at
// all -- a user is never their own pending request or friend, by
// construction, so there is nothing for the provider to compute. Wiring a
// provider that would answer something else proves self-detection happens
// FIRST, unconditionally.
func TestLookup_SelfNeverConsultsTheProvider(t *testing.T) {
	db := testDB(t)
	fake := &fakeFriendshipProvider{status: FriendshipFriends} // deliberately wrong, to prove it's never asked
	svc := newSvc(db).WithFriendships(fake)
	id := seedUser(t, db)
	retireCleanup(t, db, "selfhandle")

	_, err := svc.Claim(context.Background(), id, "selfhandle")
	require.NoError(t, err)

	got, err := svc.Lookup(context.Background(), id, "selfhandle")
	require.NoError(t, err)
	require.Equal(t, FriendshipSelf, got.FriendshipStatus)
	require.Zero(t, fake.calls, "self-lookup must short-circuit before the provider is ever consulted")
}
