package nutrition

import (
	"strings"
	"unicode"
)

// Normalize reduces a food phrase to a canonical form for alias/index matching:
// lowercase, punctuation → space, collapsed whitespace, trailing-plural trimmed.
func Normalize(phrase string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(phrase) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(' ')
		}
	}
	words := strings.Fields(b.String())
	for i, w := range words {
		words[i] = singularize(w)
	}
	return strings.Join(words, " ")
}

func singularize(w string) string {
	if len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
		return w[:len(w)-1]
	}
	return w
}

// connectors are function words that carry no food identity and are spelled
// inconsistently between what a user types and how a reference dataset writes
// a name. AUSNUT and AFCD write the conjunction as "&" ("Bacon & egg roll"),
// which Normalize turns into whitespace, so the stored name carries no
// conjunction token at all — while the user types the word ("bacon and egg
// roll").
//
// That mismatch is fatal at RECALL because the predicate is
// plainto_tsquery('simple', ...): the `simple` text-search configuration has no
// stopword list, so every one of these words survives as a MANDATORY lexeme.
// "bacon and egg roll" became 'bacon' & 'and' & 'egg' & 'roll', no row contains
// all four, and the correct row was never a candidate to rank (kora#235).
//
// The list is deliberately short and limited to pure function words. Anything
// that can name or qualify a food — "raw", "hot", "half" — must NOT be here:
// dropping those would widen recall into genuinely different foods.
var connectors = map[string]bool{
	"and": true, "or": true, "with": true, "of": true,
	"the": true, "a": true, "an": true, "in": true, "on": true, "to": true,
}

// StripConnectors removes connector words (see `connectors`) from an
// already-Normalize()d phrase.
//
// It is applied ONLY to the recall string fed to plainto_tsquery, where its
// effect is monotonic: plainto_tsquery ANDs its terms, so removing a term can
// only ever ADD candidates and can never drop a row that already matched. That
// is what makes this safe to ship without re-ranking everything — the scorer
// still sees the full phrase and decides the order.
//
// A phrase made ENTIRELY of connectors returns unchanged rather than empty: an
// empty tsquery matches nothing, which would turn a harmless odd query into a
// zero-candidate resolve — the very failure this function exists to remove.
func StripConnectors(normalized string) string {
	fields := strings.Fields(normalized)
	kept := make([]string, 0, len(fields))
	for _, w := range fields {
		if !connectors[w] {
			kept = append(kept, w)
		}
	}
	if len(kept) == 0 {
		return normalized
	}
	return strings.Join(kept, " ")
}
