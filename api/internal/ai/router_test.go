package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRouter_PrimarySucceeds_IdentifyText(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		guesses:    []Guess{{Food: "apple", Confidence: 0.9}},
		guessUsage: Usage{Provider: "primary-stub"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, usage, err := r.IdentifyText(context.Background(), "apple")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "apple", Confidence: 0.9}}, guesses)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 1, primary.calls)
	assert.Equal(t, 0, fallback.calls, "fallback must not be called when primary succeeds")
}

func TestRouter_PrimarySucceeds_Embed(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		embedding:  []float32{0.1, 0.2, 0.3},
		embedUsage: Usage{Provider: "primary-stub"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, usage, err := r.Embed(context.Background(), "chicken breast")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.1, 0.2, 0.3}, vec)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 0, fallback.calls)
}

func TestRouter_PrimaryErrors_FallsBackToFallback_IdentifyText(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", guessErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "banana", Confidence: 0.8}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, usage, err := r.IdentifyText(context.Background(), "banana")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "banana", Confidence: 0.8}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

func TestRouter_PrimaryErrors_FallsBackToFallback_Embed(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", embedErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		embedding:  []float32{0.4, 0.5},
		embedUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, usage, err := r.Embed(context.Background(), "rice")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.4, 0.5}, vec)
	assert.Equal(t, "fallback-stub", usage.Provider)
}

// TestRouter_PrimaryExceedsBudget_FallsBack verifies the latency-fallback
// path deterministically and fast: the primary stub blocks on ctx.Done()
// (simulating a hung call), and the Router's TextBudget field is overridden
// to a small value so the test doesn't need to wait out the real 1.5s
// production budget. Router.TextBudget/PhotoBudget default to the package
// consts (textBudget/photoBudget) when zero, so overriding them here doesn't
// touch production behavior.
func TestRouter_PrimaryExceedsBudget_FallsBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "slow-timeout-fallback"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond}

	start := time.Now()
	guesses, usage, err := r.IdentifyText(context.Background(), "slow")
	elapsed := time.Since(start)

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "slow-timeout-fallback"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Less(t, elapsed, 500*time.Millisecond, "router must give up on primary within its budget, not the production default")
}

func TestRouter_PrimaryExceedsBudget_FallsBack_Embed(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		embedding:  []float32{0.9},
		embedUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond}

	vec, usage, err := r.Embed(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.9}, vec)
	assert.Equal(t, "fallback-stub", usage.Provider)
}

// TestRouter_FallbackGetsGenerousBudget verifies the fallback is NOT capped at
// the primary's tight latency budget: primary times out fast (20ms), and the
// fallback takes longer than that budget (60ms) but well under its own
// FallbackBudget (500ms), so it must still succeed. Before the dedicated
// fallback budget, the fallback shared the 20ms cap and would be cancelled.
func TestRouter_FallbackGetsGenerousBudget(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		delay:      60 * time.Millisecond,
		guesses:    []Guess{{Food: "slow-but-served"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond, FallbackBudget: 500 * time.Millisecond}

	guesses, usage, err := r.IdentifyText(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "slow-but-served"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

func TestRouter_BothError_ReturnsFallbackError(t *testing.T) {
	primaryErr := errors.New("primary exploded")
	fallbackErr := errors.New("fallback exploded too")
	primary := &stubProvider{name: "primary-stub", guessErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", guessErr: fallbackErr}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, _, err := r.IdentifyText(context.Background(), "apple")

	require.Error(t, err)
	assert.ErrorIs(t, err, fallbackErr)
	assert.Nil(t, guesses)
}

func TestRouter_BothError_ReturnsFallbackError_Embed(t *testing.T) {
	primaryErr := errors.New("primary exploded")
	fallbackErr := errors.New("fallback exploded too")
	primary := &stubProvider{name: "primary-stub", embedErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", embedErr: fallbackErr}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, _, err := r.Embed(context.Background(), "apple")

	require.Error(t, err)
	assert.ErrorIs(t, err, fallbackErr)
	assert.Nil(t, vec)
}

// TestRouter_Transcribe_NoFallback_ReturnsPrimaryError proves Transcribe does
// NOT fall back: audio has no meaningful fallback (only the multimodal
// primary can transcribe), so a primary error must be surfaced directly
// instead of being masked behind the fallback's guaranteed "not supported".
func TestRouter_Transcribe_NoFallback_ReturnsPrimaryError(t *testing.T) {
	primaryErr := errors.New("gemini transcribe boom")
	primary := &stubProvider{name: "primary-stub", transcriptErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", transcript: "should not be used"}
	r := &Router{Primary: primary, Fallback: fallback}
	_, _, err := r.Transcribe(context.Background(), []byte("audio"), "audio/mp4")
	require.ErrorIs(t, err, primaryErr)
	assert.Equal(t, 0, fallback.calls, "Transcribe must not fall back (audio has no text-model fallback)")
}

// TestRouter_Transcribe_PrimarySucceeds proves the positive path still works
// now that Transcribe calls the primary directly.
func TestRouter_Transcribe_PrimarySucceeds(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", transcript: "chicken and rice", transcriptUsage: Usage{Provider: "primary-stub"}}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}
	got, usage, err := r.Transcribe(context.Background(), []byte("audio"), "audio/mp4")
	require.NoError(t, err)
	assert.Equal(t, "chicken and rice", got)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 0, fallback.calls)
}

func TestRouter_Name(t *testing.T) {
	r := &Router{
		Primary:  &stubProvider{name: "primary-stub"},
		Fallback: &stubProvider{name: "fallback-stub"},
	}

	assert.Equal(t, "router(primary-stub->fallback-stub)", r.Name())
}

var _ Provider = (*Router)(nil)
