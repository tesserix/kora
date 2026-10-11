// Package identity owns handles: the sayable name a Kora user can be found
// by, and the profile picture attached to it.
package identity

import (
	"strings"

	"github.com/tesserix/kora/api/internal/handlefold"
)

// Handle length bounds, measured on the display form. Three is the shortest
// thing worth saying aloud; twenty is longer than anyone will read out.
const (
	MinHandleLen = 3
	MaxHandleLen = 20
)

// fold applies the confusables mapping to a string, replacing each character
// with its canonical representative. The result is used for lookups and
// uniqueness checks. The mapping itself lives in internal/handlefold, not
// here, so that internal/user's tests can compute the same canonical form
// without importing internal/identity (which would cycle: identity already
// imports user via handler.go and repository.go). See handlefold's doc
// comment for the full reasoning.
func fold(s string) string {
	return handlefold.Fold(s)
}

// reservedNames holds the source-of-truth list of reserved handle names,
// expressed in human-readable form (not folded). The list is folded once at
// package init to create the reserved map, ensuring all reserved names are
// checked against their canonical forms. This approach (derive, not hand-write)
// prevents drift when confusables change: the folding logic is identical to
// what Canonical() uses, and there is a single source of truth.
var reservedNames = []string{"kora", "admin", "support", "help", "team"}

// reserved maps canonical forms of reserved names to struct{}, used to prevent
// claiming handles that would impersonate Kora itself. The map is pre-computed
// from reservedNames to avoid re-folding on every Canonical() call.
var reserved map[string]struct{}

func init() {
	reserved = make(map[string]struct{})
	for _, name := range reservedNames {
		reserved[fold(name)] = struct{}{}
	}
}

// Canonical validates raw and returns the form to display and the form to
// index and look up by. Display is trimmed and lowercased but NOT folded, so
// a user who chose `ada_l` is never shown `ada_1` as their own handle.
func Canonical(raw string) (string, string, error) {
	display := strings.ToLower(strings.TrimSpace(raw))
	// People say and write handles with a leading @. Accepting it here means
	// pasting `@ada` from a message thread works, rather than failing shape
	// validation for a character that was never part of the handle.
	display = strings.TrimPrefix(display, "@")

	if len(display) < MinHandleLen || len(display) > MaxHandleLen {
		return "", "", ErrHandleInvalid
	}
	for _, r := range display {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			continue
		}
		return "", "", ErrHandleInvalid
	}

	canonical := fold(display)

	if _, bad := reserved[canonical]; bad {
		return "", "", ErrHandleReserved
	}
	return display, canonical, nil
}
