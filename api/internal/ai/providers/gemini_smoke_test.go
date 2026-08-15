//go:build smoke

package providers

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestGeminiProvider_IdentifyText_Smoke makes one real call to the Gemini
// API. It is excluded from the normal `go test ./...` build (requires
// `-tags smoke`) and is gated on GEMINI_API_KEY so it never runs by
// accident in CI without a key configured.
func TestGeminiProvider_IdentifyText_Smoke(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY not set; skipping live Gemini smoke test")
	}

	ctx := context.Background()
	provider, err := NewGeminiProvider(ctx, apiKey)
	require.NoError(t, err)

	guesses, usage, err := provider.IdentifyText(ctx, "a bowl of grilled chicken and white rice")
	require.NoError(t, err)
	require.NotEmpty(t, guesses)
	require.NotEmpty(t, guesses[0].Food)
	require.Equal(t, "gemini", usage.Provider)
	require.Equal(t, callTypeIdentifyText, usage.CallType)
}

// TestGeminiProvider_Embed_Smoke makes one real embedding call to the Gemini
// API and asserts the vector is exactly 768-dim, matching the nutrition
// index's vector(768) column. Same gating as the IdentifyText smoke test.
func TestGeminiProvider_Embed_Smoke(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY not set; skipping live Gemini smoke test")
	}

	ctx := context.Background()
	provider, err := NewGeminiProvider(ctx, apiKey)
	require.NoError(t, err)

	vec, usage, err := provider.Embed(ctx, "grilled chicken")
	require.NoError(t, err)
	require.Len(t, vec, 768)
	require.Equal(t, "gemini", usage.Provider)
	require.Equal(t, callTypeEmbed, usage.CallType)
}

// TestGeminiProvider_IdentifyText_PreservesStatedQuantity_Smoke is a
// REGRESSION GUARD, and it exists because of a misdiagnosis (kora#184).
//
// "El Janah 1/2 chicken with Chips" appeared in the logs as `chicken@0.95;
// chips@0.95`, which read as the model having thrown the user's "1/2" away.
// It had not: a live call returns `chicken` with PortionEstimate "1/2 chicken".
// The diagnostic log simply did not print PortionEstimate. The quantity is
// actually lost further down, in portionGramsFor, which cannot parse the
// fraction and falls through to a flat 100 g.
//
// So this test does not pin a fix — it pins the fact that identify ALREADY
// does the right thing, so nobody "fixes" the prompt for a problem it does not
// have. Asserted loosely: the model is non-deterministic and the wording will
// vary, so it checks the stated quantity survives in some form.
func TestGeminiProvider_IdentifyText_PreservesStatedQuantity_Smoke(t *testing.T) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		t.Skip("GEMINI_API_KEY not set; skipping live Gemini smoke test")
	}

	ctx := context.Background()
	provider, err := NewGeminiProvider(ctx, apiKey)
	require.NoError(t, err)

	guesses, _, err := provider.IdentifyText(ctx, "El Janah 1/2 chicken with Chips")
	require.NoError(t, err)
	require.NotEmpty(t, guesses)

	var joined string
	for _, g := range guesses {
		joined += " " + strings.ToLower(g.Food) + " | " + strings.ToLower(g.PortionEstimate)
	}
	t.Logf("guesses: %s", joined)

	// The user stated a quantity. It must reach the resolver somewhere —
	// either in the portion estimate or in the food phrase itself.
	require.True(t,
		strings.Contains(joined, "1/2") || strings.Contains(joined, "half") || strings.Contains(joined, "0.5"),
		"the stated quantity '1/2' was discarded entirely: %s", joined)
}
