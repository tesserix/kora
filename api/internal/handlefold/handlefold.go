// Package handlefold implements the confusable-character folding used to
// compute a handle's canonical (lookup/index) form: `l`, `i` and `1` fold to
// `1`; `o` and `0` fold to `0`. It is applied to the canonical form, which the
// unique index is built on, so at most ONE handle can exist per confusable
// class -- that is what makes folding on LOOKUP unambiguous rather than
// lossy.
//
// This package holds NO dependency on internal/identity or internal/user, on
// purpose: internal/identity imports internal/user (handler.go,
// repository.go), so internal/user must never import internal/identity or
// anything that does. Both packages need the exact same fold -- identity's
// production code when it validates and stores a handle, and internal/user's
// deletion tests when they clean up the retired_handles row a test wrote by
// hand -- and handlefold is the one place that fold is implemented, so the
// two can never drift apart. That drift already broke this suite once: a
// test cleanup hand-wrote 'dropped' when the row actually written was
// 'dr0pped' (o -> 0), leaving a stray retirement that failed the next run.
package handlefold

import "strings"

// confusables maps every character in a spoken-ambiguity class to one
// representative.
var confusables = map[rune]rune{
	'l': '1', 'i': '1', '1': '1',
	'o': '0', '0': '0',
}

// Fold applies the confusables mapping to s, replacing each character with
// its canonical representative. It does not lowercase, trim, or otherwise
// normalise -- callers that need the full pipeline should use Canonical.
func Fold(s string) string {
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

// Normalize lowercases raw, trims surrounding whitespace, and strips a
// leading '@' (people say and write handles with one, e.g. pasting `@ada`
// from a message thread). It does NOT fold confusables -- that is a separate
// step so callers that need the unfolded display form (identity.Canonical)
// can still get it.
func Normalize(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	return strings.TrimPrefix(s, "@")
}

// Canonical runs the full pipeline -- Normalize then Fold -- and returns the
// canonical (lookup/index) form of raw, with no validation. It exists for
// callers that only need the canonical string and are not claiming or
// displaying the handle, such as a test cleanup deleting a retired_handles
// row by the exact value the production code would have written. Callers
// that ARE claiming or displaying a handle should use identity.Canonical,
// which validates shape and reserved names first.
func Canonical(raw string) string {
	return Fold(Normalize(raw))
}
