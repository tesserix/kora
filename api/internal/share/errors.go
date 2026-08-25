package share

import "errors"

var (
	// ErrDuplicateName is a circle name the owner already uses. Compared
	// case-insensitively and trimmed, matching share_circles_owner_name.
	ErrDuplicateName = errors.New("share: duplicate circle name")
	// ErrNotOwner is any attempt to modify a circle you do not own.
	ErrNotOwner = errors.New("share: not the circle owner")
	// ErrNotFriends is an attempt to add someone who is not an accepted friend.
	ErrNotFriends = errors.New("share: not friends")
)
