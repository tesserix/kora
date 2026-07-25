package social

import "errors"

var (
	ErrBadInput     = errors.New("provide exactly one of email or code")
	ErrUserNotFound = errors.New("no matching Kora account")
	ErrSelfFriend   = errors.New("cannot friend yourself")
	ErrNotFound     = errors.New("friendship not found")
	ErrForbidden    = errors.New("not allowed")
)
