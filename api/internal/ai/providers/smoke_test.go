//go:build smoke

package providers

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestNVIDIAFallbackSmoke exercises the OpenAI-compatible adapter against the
// live NVIDIA NIM endpoint. Run with:
//
//	OPENAI_API_KEY=$NVIDIA_API_KEY \
//	OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
//	go test -tags smoke ./internal/ai/providers/ -run TestNVIDIAFallbackSmoke -v
//
// NVIDIA cold starts are slow; allow a generous timeout.
func TestNVIDIAFallbackSmoke(t *testing.T) {
	key := os.Getenv("OPENAI_API_KEY")
	base := os.Getenv("OPENAI_BASE_URL")
	if key == "" || base == "" {
		t.Skip("OPENAI_API_KEY/OPENAI_BASE_URL not set — skipping NVIDIA smoke")
	}
	p := NewOpenAIProvider(key, base, "meta/llama-3.3-70b-instruct", true)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	guesses, usage, err := p.IdentifyText(ctx, "two eggs and toast")
	if err != nil {
		t.Fatalf("IdentifyText: %v", err)
	}
	if len(guesses) == 0 {
		t.Fatal("expected at least one guess")
	}
	for _, g := range guesses {
		if g.Food == "" {
			t.Fatalf("empty food in guess: %+v", g)
		}
	}
	t.Logf("guesses=%+v usage=%+v", guesses, usage)
}
