package identity

import "errors"

// The four handle-write failures are distinct errors on purpose: the spec
// requires PUT /v1/me/handle to answer differently for "taken", "invalid
// shape", "reserved" and "retired". Collapsing any two of them turns a
// fixable mistake into a dead end for the person typing.
//
// "Taken" is deliberately NOT treated as a privacy leak. A handle's existence
// is discoverable by definition, since exact-match lookup exists.
var (
	ErrHandleInvalid  = errors.New("identity: handle has an invalid shape")
	ErrHandleReserved = errors.New("identity: handle is reserved")
	ErrHandleTaken    = errors.New("identity: handle is taken")
	ErrHandleRetired  = errors.New("identity: handle was retired and cannot be reused")
	ErrNotFound       = errors.New("identity: not found")
)
