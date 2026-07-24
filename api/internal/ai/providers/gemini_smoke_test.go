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
