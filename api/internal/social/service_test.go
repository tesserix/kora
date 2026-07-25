package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/user"
)

func TestSendRequestRejectsSelfAndMissing(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	svc := NewService(NewRepository(db), user.NewRepository(db))

	// self by email
	selfEmail := "so-" + me.String() + "@test.dev"
	_, err := svc.SendRequest(context.Background(), me, selfEmail, "")
	require.ErrorIs(t, err, ErrSelfFriend)

	// unknown email
	_, err = svc.SendRequest(context.Background(), me, "nobody@nowhere.dev", "")
	require.ErrorIs(t, err, ErrUserNotFound)

	// both provided
	_, err = svc.SendRequest(context.Background(), me, selfEmail, "CODE")
	require.ErrorIs(t, err, ErrBadInput)
}

func TestSendRequestCreatesPendingThenReversePendingAutoAccepts(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	bEmail := "so-" + b.String() + "@test.dev"
	aEmail := "so-" + a.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)

	// same-direction again is idempotent (still pending)
	f2, err := svc.SendRequest(context.Background(), a, bEmail, "")
	require.NoError(t, err)
	require.Equal(t, f.ID, f2.ID)

	// b requests a -> reverse pending -> auto-accept
	f3, err := svc.SendRequest(context.Background(), b, aEmail, "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusAccepted, f3.Status)

	friends, err := svc.ListFriends(context.Background(), a)
	require.NoError(t, err)
	require.Len(t, friends, 1)
	require.Equal(t, "Ben", friends[0].DisplayName)
}

func TestAcceptDeclineAuthorizationAndUnfriend(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	c := seedUser(t, db, "Cy")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	bEmail := "so-" + b.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "") // a->b pending
	require.NoError(t, err)

	// c (not the addressee) cannot accept
	require.ErrorIs(t, svc.Accept(context.Background(), c, f.ID), ErrForbidden)
	// b (addressee) accepts
	require.NoError(t, svc.Accept(context.Background(), b, f.ID))

	// unfriend removes it
	require.NoError(t, svc.Unfriend(context.Background(), a, b))
	friends, err := svc.ListFriends(context.Background(), a)
	require.NoError(t, err)
	require.Len(t, friends, 0)
}

func TestMyCodeIsStable(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	code1, link, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.NotEmpty(t, code1)
	require.Equal(t, "mobile://friend/"+code1, link)
	code2, _, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.Equal(t, code1, code2) // stable across calls
}
