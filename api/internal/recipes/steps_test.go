package recipes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestNormalizeSteps proves the sequence semantics: order preserved, empties
// dropped, duplicates KEPT (unlike tags), over-length truncated, capped.
func TestNormalizeSteps(t *testing.T) {
	got := normalizeSteps([]string{"  Rinse the lentils ", "", "   ", "Simmer 25 minutes"})
	require.Equal(t, []string{"Rinse the lentils", "Simmer 25 minutes"}, got,
		"trimmed, empties dropped, order preserved")

	require.Empty(t, normalizeSteps(nil))

	// Duplicates are legitimate in a method — "stir" can appear twice.
	require.Equal(t, []string{"stir", "stir"}, normalizeSteps([]string{"stir", "stir"}))

	long := strings.Repeat("a", 600)
	out := normalizeSteps([]string{long})
	require.Len(t, out, 1)
	require.Len(t, out[0], maxStepLen, "over-length is truncated, not rejected")

	many := make([]string, 50)
	for i := range many {
		many[i] = "step"
	}
	require.Len(t, normalizeSteps(many), maxSteps, "must cap at maxSteps")
}
