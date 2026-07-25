package challenges

import "errors"

var (
	ErrNotFound  = errors.New("challenge not found")
	ErrForbidden = errors.New("not allowed")
	ErrBadInput  = errors.New("invalid input")
)
