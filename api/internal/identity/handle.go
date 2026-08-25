// Package identity owns handles: the sayable name a Kora user can be found
// by, and the profile picture attached to it.
package identity

import "strings"

// Handle length bounds, measured on the display form. Three is the shortest
// thing worth saying aloud; twenty is longer than anyone will read out.
const (
	MinHandleLen = 3
	MaxHandleLen = 20
)

// confusables maps every character in a spoken-ambiguity class to one
// representative. `l`, `i` and `1` are one class; `o` and `0` are another.
//
// This is applied to the canonical form, which the unique index is built on,
// so at most ONE handle can exist per confusable class. That is what makes
// folding on LOOKUP unambiguous rather than lossy: whichever member of the
// class exists is necessarily the one the speaker meant, so a handle heard
// correctly always resolves.
var confusables = map[rune]rune{
	'l': '1', 'i': '1', '1': '1',
	'o': '0', '0': '0',
}

// fold applies the confusables mapping to a string, replacing each character
// with its canonical representative. The result is used for lookups and
// uniqueness checks.
func fold(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if folded, ok := confusables[r]; ok {
			b.WriteRune(folded)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
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
