package recipes

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTag(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
		ok   bool
	}{
		{"lowercases", "Vegetarian", "vegetarian", true},
		{"trims", "  dinner  ", "dinner", true},
		{"collapses internal whitespace", "high    protein", "high protein", true},
		{"keeps hyphens", "High-Protein", "high-protein", true},
		{"keeps digits", "30 minute", "30 minute", true},
		{"drops punctuation", "veg!!!, dinner?", "veg dinner", true},
		{"empty input", "", "", false},
		{"punctuation only", "!!!", "", false},
		{"whitespace only", "   ", "", false},
		{"truncates over 30 chars", "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd", "aaaaaaaaaabbbbbbbbbbcccccccccc", true},
		{"unicode letters kept", "Café", "café", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := normalizeTag(c.in)
			require.Equal(t, c.ok, ok)
			require.Equal(t, c.want, got)
		})
	}
}

// TestNormalizeTags proves the set semantics: de-duplicated, alphabetical,
// capped, with unusable entries dropped rather than failing the whole call.
func TestNormalizeTags(t *testing.T) {
	got := normalizeTags([]string{"Dinner", "dinner ", "!!!", "Vegetarian", ""})
	require.Equal(t, []string{"dinner", "vegetarian"}, got)

	require.Empty(t, normalizeTags(nil))

	many := make([]string, 0, 15)
	for _, s := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"} {
		many = append(many, s)
	}
	require.Len(t, normalizeTags(many), maxTags, "must cap at maxTags")
}

// TestNormalizeTagDoesNotSingularise pins the deliberate difference from
// nutrition.Normalize: tags are a different domain and must not be mangled by
// food-matching rules.
func TestNormalizeTagDoesNotSingularise(t *testing.T) {
	got, ok := normalizeTag("greens")
	require.True(t, ok)
	require.Equal(t, "greens", got, "tags must not be singularised")

	got, ok = normalizeTag("high-protein")
	require.True(t, ok)
	require.Equal(t, "high-protein", got, "hyphens must survive")
}
