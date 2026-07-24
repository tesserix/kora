//go:build smoke

package providers

import (
	"context"
	"os"
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
