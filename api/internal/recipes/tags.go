package recipes

import (
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
)

const (
	// maxTags bounds a recipe's tag set. Beyond this they stop being a filter
	// and become noise.
	maxTags = 10
	// maxTagLen bounds one tag. Over-length input is TRUNCATED, not rejected —
	// a long tag is a typo, not a reason to fail someone's save.
	maxTagLen = 30
)

// Tag is one tag on one recipe. The table's composite primary key
// (recipe_id, tag) enforces de-duplication in the database, so there is no id
// column and no position: tags are a set, not a sequence.
type Tag struct {
	RecipeID uuid.UUID `gorm:"type:uuid;not null;primaryKey"`
	Tag      string    `gorm:"not null;primaryKey"`
}

func (Tag) TableName() string { return "recipe_tags" }

// normalizeTag reduces one tag to canonical form: lowercase, trimmed,
// internal whitespace collapsed, punctuation dropped, hyphens and digits kept.
// The bool reports whether anything usable survived.
//
// nutrition.Normalize is deliberately NOT reused here. It singularises and
// strips punctuation for food-index matching, which would turn "high-protein"
// into "high protein" and "greens" into "green". Tags are a different domain,
// and sharing a normaliser would mean a change to food matching silently
// rewriting users' tags.
func normalizeTag(raw string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case r == '-':
			b.WriteRune('-')
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			// Punctuation becomes a space so "veg,dinner" splits rather than
			// fusing into one nonsense tag.
			b.WriteRune(' ')
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if out == "" {
		return "", false
	}
	if len(out) > maxTagLen {
		out = strings.TrimSpace(out[:maxTagLen])
	}
	if out == "" {
		return "", false
	}
	return out, true
}

// normalizeTags turns caller input into the canonical set stored on a recipe:
// normalised, de-duplicated, alphabetical, capped at maxTags. Entries that
// normalise to nothing are dropped silently — the user typed punctuation, not
// a tag, and failing their whole save over it would be hostile.
func normalizeTags(raw []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		t, ok := normalizeTag(r)
		if !ok {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	sort.Strings(out)
	if len(out) > maxTags {
		out = out[:maxTags]
	}
	return out
}
