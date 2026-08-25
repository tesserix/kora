package identity

import (
	"context"

	"github.com/google/uuid"
)

// FriendshipStatus tells Lookup's caller their existing relationship with the
// looked-up person, so a client can render the right action instead of a live
// "Send request" no matter what (kora#453). Sending a request is idempotent
// either way (social.Service.SendRequest returns an existing accepted
// friendship unchanged and accepts a reverse-pending request rather than
// duplicating it) -- this field is about the button looking right, not about
// preventing a bad write.
//
// This is the wire contract: LookupView serialises it as the JSON field
// "friendship_status", and these five string values are exactly what a
// client must switch on. Get one wrong on either side and the client falls
// through to a default case silently -- there is no compiler to catch a
// string literal typo across a language boundary.
type FriendshipStatus string

const (
	// FriendshipNone: no relationship exists yet. Render "Send request".
	FriendshipNone FriendshipStatus = "none"
	// FriendshipRequestSent: the viewer already sent a request and it is
	// still pending. Render "Requested", not a live send button.
	FriendshipRequestSent FriendshipStatus = "request_sent"
	// FriendshipRequestReceived: the looked-up person already sent THE
	// VIEWER a request. Render "Respond" (accept/decline) -- sending here
	// would be accepted outright by SendRequest's idempotency, but a button
	// that says "Send request" when a response is what's actually pending
	// is exactly the wrong-looking state kora#453 exists to fix.
	FriendshipRequestReceived FriendshipStatus = "request_received"
	// FriendshipFriends: an accepted friendship exists. Render "Already
	// friends", not a send button.
	FriendshipFriends FriendshipStatus = "friends"
	// FriendshipSelf: the viewer looked up their own handle. Neither "none"
	// (which would invite a client to offer sending yourself a request) nor
	// "friends" (which would be a lie) is honest here, so this gets its own
	// value -- the one case Lookup can answer with no DB round trip at all,
	// since a user is never someone's pending request or friend of
	// themselves.
	FriendshipSelf FriendshipStatus = "self"
)

// FriendshipStatusProvider tells Lookup the viewer's relationship to the
// looked-up user.
//
// Declared HERE, at the consumer, not as a social.Repository or
// social.Service, because internal/social imports internal/identity (added
// when handle-based friend requests shipped, kora#449 task 13b) -- the
// reverse import would cycle. social.Service satisfies this structurally at
// the wiring site (internal/server/router.go), the same consumer-declared-
// interface pattern as CacheEvicter / IdentityDeleter / AppleRevoker in
// internal/user/deletion.go.
//
// It may be nil: a Service wired without one (identity's own unit tests,
// or a future caller that only needs Claim/Clear/avatars) must degrade
// Lookup's friendship_status to FriendshipNone rather than panic -- the same
// treatment the nil Apple client and nil ObjectDeleter get in
// internal/user/deletion.go.
type FriendshipStatusProvider interface {
	FriendshipStatus(ctx context.Context, viewerID, otherID uuid.UUID) (FriendshipStatus, error)
}
