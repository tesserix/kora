//go:build smoke

package providers

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestOpenAIProvider_IdentifyText_Smoke makes one real call to the OpenAI
// API. It is excluded from the normal `go test ./...` build (requires
// `-tags smoke`) and is gated on OPENAI_API_KEY so it never runs by accident
// in CI without a key configured.
func TestOpenAIProvider_IdentifyText_Smoke(t *testing.T) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		t.Skip("OPENAI_API_KEY not set; skipping live OpenAI smoke test")
	}

	ctx := context.Background()
	provider := NewOpenAIProvider(apiKey, "", "", false)

	guesses, usage, err := provider.IdentifyText(ctx, "a bowl of grilled chicken and white rice")
	require.NoError(t, err)
	require.NotEmpty(t, guesses)
	require.NotEmpty(t, guesses[0].Food)
	require.Equal(t, "openai", usage.Provider)
	require.Equal(t, callTypeIdentifyText, usage.CallType)
}
