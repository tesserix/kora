package diet

import (
	"sort"
	"strings"
)

// tagPrefix marks a derived fact about a food rather than a user's rule.
const tagPrefix = "contains-"

// TagFor is the food_items.diet_tags value for a subject.
func TagFor(subject string) string {
	return tagPrefix + strings.ReplaceAll(subject, " ", "-")
}

// SubjectFromTag is the inverse of TagFor. The bool reports whether tag was a
// containment tag at all.
func SubjectFromTag(tag string) (string, bool) {
	rest, ok := strings.CutPrefix(tag, tagPrefix)
	if !ok {
		return "", false
	}
	return strings.ReplaceAll(rest, "-", " "), true
}

// TagsFor derives the containment tags for one food. Ingredients are the
// authoritative signal where a source has them — the curated converters build
// every dish from a weighted ingredient list — and name and brand are the
// fallback for sources that do not.
//
// Negation is ignored: an ingredient list and a product name state what is in
// the food, and "sugar free" qualifies the sugar, not the milk beside it.
func TagsFor(name, brand string, ingredients []string) []string {
	parts := append([]string{name, brand}, ingredients...)
	seen := map[string]struct{}{}
	for _, part := range parts {
		for _, h := range Match(part) {
			seen[h.Subject] = struct{}{}
		}
	}

	out := make([]string, 0, len(seen))
	for subject := range seen {
		out = append(out, TagFor(subject))
	}
	sort.Strings(out)
	return out
}

// BlockedTags and FlaggedTags are the tag sets a profile forbids and warns
// about, ready to hand to a `diet_tags && $1` containment query.
func BlockedTags(p Profile) []string { return tagsOf(p.Blocked()) }
func FlaggedTags(p Profile) []string { return tagsOf(p.Flagged()) }

func tagsOf(subjects []string) []string {
	out := make([]string, 0, len(subjects))
	for _, s := range subjects {
		out = append(out, TagFor(s))
	}
	return out
}
