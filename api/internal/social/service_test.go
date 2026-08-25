package social

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/identity"
	"github.com/tesserix/kora/api/internal/user"
)

// svcWithHandles wires the same identity.Repository the real router does
// (see router.go's WithHandles(identity.NewRepository(deps.DB))), so these
// tests exercise the real handle-resolution path rather than a stub.
func svcWithHandles(db *gorm.DB) Service {
	return NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" }).
		WithHandles(identity.NewRepository(db))
}

func TestSendRequestRejectsSelfAndMissing(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })

	// self by email
	selfEmail := "so-" + me.String() + "@test.dev"
	_, err := svc.SendRequest(context.Background(), me, selfEmail, "", "")
	require.ErrorIs(t, err, ErrSelfFriend)

	// unknown email
	_, err = svc.SendRequest(context.Background(), me, "nobody@nowhere.dev", "", "")
	require.ErrorIs(t, err, ErrUserNotFound)

	// both provided
	_, err = svc.SendRequest(context.Background(), me, selfEmail, "CODE", "")
	require.ErrorIs(t, err, ErrBadInput)
}

func TestSendRequestCreatesPendingThenReversePendingAutoAccepts(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	bEmail := "so-" + b.String() + "@test.dev"
	aEmail := "so-" + a.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "", "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)

	// same-direction again is idempotent (still pending)
	f2, err := svc.SendRequest(context.Background(), a, bEmail, "", "")
	require.NoError(t, err)
	require.Equal(t, f.ID, f2.ID)

	// b requests a -> reverse pending -> auto-accept
	f3, err := svc.SendRequest(context.Background(), b, aEmail, "", "")
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
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	bEmail := "so-" + b.String() + "@test.dev"

	f, err := svc.SendRequest(context.Background(), a, bEmail, "", "") // a->b pending
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
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	code1, link, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.NotEmpty(t, code1)
	require.Equal(t, "mobile://friend/"+code1, link)
	code2, _, err := svc.MyCode(context.Background(), me)
	require.NoError(t, err)
	require.Equal(t, code1, code2) // stable across calls
}

func TestSendRequestByCode(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	_, _, err := svc.MyCode(context.Background(), b) // give b a friend_code
	require.NoError(t, err)
	bUser, err := user.NewRepository(db).ByID(context.Background(), b)
	require.NoError(t, err)
	f, err := svc.SendRequest(context.Background(), a, "", bUser.FriendCode, "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)
	require.Equal(t, b, f.AddresseeID)
}

func TestSendRequestNeitherFieldIsBadInput(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	_, err := svc.SendRequest(context.Background(), a, "", "", "")
	require.ErrorIs(t, err, ErrBadInput)
}

func TestDeclineDeletesAndAuthorizes(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	c := seedUser(t, db, "Cy")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	f, err := svc.SendRequest(context.Background(), a, "so-"+b.String()+"@test.dev", "", "")
	require.NoError(t, err)
	require.ErrorIs(t, svc.Decline(context.Background(), c, f.ID), ErrForbidden) // non-addressee
	require.NoError(t, svc.Decline(context.Background(), b, f.ID))               // addressee
	incoming, _, err := svc.ListRequests(context.Background(), b)
	require.NoError(t, err)
	require.Len(t, incoming, 0)
}

func TestAcceptUnknownRequestIsNotFound(t *testing.T) {
	db := testDB(t)
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	require.ErrorIs(t, svc.Accept(context.Background(), b, uuid.New()), ErrNotFound)
}

func TestListFriends_CarriesHandleAndAvatarButNeverEmail(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	them := seedUser(t, db, "Ada L")
	path := "avatars/" + them.String() + "/v1.jpg"
	require.NoError(t, db.Exec(
		`UPDATE users SET handle = 'ada', handle_canonical = 'ada', avatar_path = ? WHERE id = ?`,
		path, them).Error)
	seedAcceptedFriendship(t, db, me, them)

	svc := NewService(NewRepository(db), user.NewRepository(db),
		func(p string) string {
			if p == "" {
				return ""
			}
			return "https://assets.test/" + p
		})

	got, err := svc.ListFriends(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "ada", got[0].Handle)
	require.Equal(t, "https://assets.test/"+path, got[0].AvatarURL)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, them).Scan(&email).Error)
	require.NotEmpty(t, email)
	body, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
	require.NotContains(t, string(body), "email")
}

// A friend with no picture must produce "" rather than a URL pointing at
// nothing — the client falls back to initials on empty, and renders a broken
// image on a URL that resolves to no object.
func TestListFriends_NoAvatarIsEmptyURL(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	them := seedUser(t, db, "No Picture")
	seedAcceptedFriendship(t, db, me, them)

	svc := NewService(NewRepository(db), user.NewRepository(db),
		func(p string) string { return "https://assets.test/" + p })

	got, err := svc.ListFriends(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Empty(t, got[0].AvatarURL)
}

// claimHandleForTest wires the same identity.Service the real /me/handle
// route uses to claim raw for userID. It is the only place in this file that
// writes handle_canonical -- always through identity.Canonical's fold, never
// hand-written, per the standing rule that broke this suite once before.
func claimHandleForTest(t *testing.T, db *gorm.DB, userID uuid.UUID, raw string) {
	t.Helper()
	svc := identity.NewService(identity.NewRepository(db), func(string) string { return "" })
	_, err := svc.Claim(context.Background(), userID, raw)
	require.NoError(t, err)
}

// kora#449 task 13b: POST /v1/friends/requests must accept a handle as a
// third mutually-exclusive identifier, resolved through the SAME canonical
// fold GET /v1/users/lookup uses -- see internal/server/router.go's
// WithHandles(identity.NewRepository(deps.DB)).
func TestSendRequestByHandle_CreatesPendingResolvingSameUserLookupWould(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	claimHandleForTest(t, db, b, "benhandle")
	svc := svcWithHandles(db)

	lookupSvc := identity.NewService(identity.NewRepository(db), func(string) string { return "" })
	looked, err := lookupSvc.Lookup(context.Background(), "benhandle")
	require.NoError(t, err)
	require.Equal(t, b, looked.ID)

	f, err := svc.SendRequest(context.Background(), a, "", "", "benhandle")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)
	require.Equal(t, a, f.RequesterID)
	require.Equal(t, looked.ID, f.AddresseeID)
}

// A confusable variant of a claimed handle (ada_l claimed, ada_1 spoken) must
// resolve to the SAME person, because that fold is the whole reason exact
// lookup is safe to speak aloud. Failing this silently sends a friend request
// -- and later a share-circle invite carrying real body metrics -- to a
// stranger.
func TestSendRequestByHandle_ConfusableVariantResolvesToSameUser(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	// Claimed with the DIGIT spelling; sent with the LETTER spelling. This
	// direction matters for catching an unfolded-resolution bug: "ada_1" is
	// already its own canonical form, so an implementation that forgot to
	// fold would still happen to match it. "ada_l" is not -- it only matches
	// if the fold actually runs.
	claimHandleForTest(t, db, b, "ada_1")
	svc := svcWithHandles(db)

	f, err := svc.SendRequest(context.Background(), a, "", "", "ada_l")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)
	require.Equal(t, b, f.AddresseeID)
}

// An unknown handle must return the exact same ErrUserNotFound an unknown
// email or code returns -- not a distinct error that would tell a caller
// "that handle can't exist" apart from "nobody has it".
func TestSendRequestByHandle_UnknownHandleIsNotFound(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	svc := svcWithHandles(db)

	_, err := svc.SendRequest(context.Background(), a, "", "", "nobodyhasthis")
	require.ErrorIs(t, err, ErrUserNotFound)
}

// A malformed (too short) or reserved handle must ALSO collapse to
// ErrUserNotFound, indistinguishable from "no such user" -- distinguishing
// them would leak which handle shapes are reserved.
func TestSendRequestByHandle_MalformedOrReservedIsNotFoundNotDistinct(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	svc := svcWithHandles(db)

	_, err := svc.SendRequest(context.Background(), a, "", "", "ab") // too short
	require.ErrorIs(t, err, ErrUserNotFound)

	_, err = svc.SendRequest(context.Background(), a, "", "", "kora") // reserved
	require.ErrorIs(t, err, ErrUserNotFound)
}

// Supplying two identifiers (including handle) or none is still ErrBadInput
// -- exactly one of the three must be supplied, same rule as before handle
// existed.
func TestSendRequestByHandle_TwoOrZeroIdentifiersStillBadInput(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	svc := svcWithHandles(db)

	_, err := svc.SendRequest(context.Background(), a, "x@y.z", "", "somehandle")
	require.ErrorIs(t, err, ErrBadInput)

	_, err = svc.SendRequest(context.Background(), a, "", "CODE", "somehandle")
	require.ErrorIs(t, err, ErrBadInput)

	_, err = svc.SendRequest(context.Background(), a, "x@y.z", "CODE", "somehandle")
	require.ErrorIs(t, err, ErrBadInput)

	_, err = svc.SendRequest(context.Background(), a, "", "", "")
	require.ErrorIs(t, err, ErrBadInput)
}

// A Service built WITHOUT WithHandles (every existing caller that predates
// kora#449 task 13b) must not panic on a handle argument -- it resolves to
// ErrUserNotFound like any other unresolvable identifier, and the email/code
// paths must keep working unchanged.
func TestSendRequestByHandle_NoResolverWiredIsNotFoundNotPanic(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	svc := NewService(NewRepository(db), user.NewRepository(db), func(string) string { return "" }) // no WithHandles

	_, err := svc.SendRequest(context.Background(), a, "", "", "anything")
	require.ErrorIs(t, err, ErrUserNotFound)

	// email path still works on the same un-handle-wired Service.
	f, err := svc.SendRequest(context.Background(), a, "so-"+b.String()+"@test.dev", "", "")
	require.NoError(t, err)
	require.Equal(t, FriendStatusPending, f.Status)
}
