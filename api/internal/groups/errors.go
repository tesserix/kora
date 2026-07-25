package groups

import "errors"

var (
	ErrNotFound         = errors.New("group not found")
	ErrForbidden        = errors.New("not allowed")
	ErrBadInput         = errors.New("invalid input")
	ErrOwnerCannotLeave = errors.New("owner cannot leave; delete the group instead")
	ErrNotFriends       = errors.New("can only invite an accepted friend")
)
