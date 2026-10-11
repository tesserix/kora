package identity

import "github.com/google/uuid"

// LookupView is everything a handle lookup returns. It is a PROJECTION chosen
// field by field, following the same rule as social.FriendView and
// share.MemberView: never an email, never the model struct.
//
// The avatar is here, at lookup, rather than after friendship, because the
// handle IS the consent boundary: if you gave someone your handle they may see
// your face. Deferring the picture until after a request is accepted would not
// solve the problem it exists for -- you would still be sending that request
// based on a display name that is not unique.
type LookupView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Handle      string    `json:"handle"`
	// AvatarURL is "" when the user has no picture. The client falls back to
	// initials on empty, so a URL that resolves to nothing is worse than none.
	AvatarURL string `json:"avatar_url"`
	// FriendshipStatus is the viewer's relationship to this person (kora#453)
	// -- see FriendshipStatus's doc comment for the exact five wire values.
	// It is "none" whenever Lookup was not given a FriendshipStatusProvider,
	// which is a degrade, not a claim that no relationship exists.
	FriendshipStatus FriendshipStatus `json:"friendship_status"`
}
