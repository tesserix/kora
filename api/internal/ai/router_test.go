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

// TestRouterGenerateText_PrimarySucceeds proves GenerateText delegates to
// Primary and never touches Fallback when Primary succeeds.
func TestRouterGenerateText_PrimarySucceeds(t *testing.T) {
	primary := &stubProvider{
		name:      "primary-stub",
		text:      "hi",
		textUsage: Usage{Provider: "fake", Model: "m"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	got, usage, err := r.GenerateText(context.Background(), "sys", "user")

	require.NoError(t, err)
	assert.Equal(t, "hi", got)
	assert.Equal(t, "fake", usage.Provider)
	assert.Equal(t, "m", usage.Model)
	assert.Equal(t, 0, fallback.calls, "fallback must not be called when primary succeeds")
}

// TestRouterGenerateText_PrimaryErrors_FallsBack proves GenerateText retries
// against Fallback when Primary errors, and returns the fallback's text.
func TestRouterGenerateText_PrimaryErrors_FallsBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", textErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:      "fallback-stub",
		text:      "fallback text",
		textUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	got, usage, err := r.GenerateText(context.Background(), "sys", "user")

	require.NoError(t, err)
	assert.Equal(t, "fallback text", got)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

func TestRouter_Name(t *testing.T) {
	r := &Router{
		Primary:  &stubProvider{name: "primary-stub"},
		Fallback: &stubProvider{name: "fallback-stub"},
	}

	assert.Equal(t, "router(primary-stub->fallback-stub)", r.Name())
}

var _ Provider = (*Router)(nil)

// TestRouter_IdentifyPhoto_DoesNotFallBack pins the deliberate absence of a
// photo fallback, mirroring Transcribe.
//
// This is not a style choice, it is a production finding. The fallback is an
// OpenAI-compatible endpoint driven by ONE configured model (OpenAIProvider
// uses p.model for text and vision alike), and prod sets that to
// meta/llama-3.3-70b-instruct — text-only. So every photo resolve did this:
// Gemini got photoBudget to answer, timed out, and the call fell through to a
// model that cannot see the image, which then burned ~27s before failing.
// Observed as POST /v1/resolve/photo -> 500 in latency_ms 30450, and it is why
// identify_photo has never recorded a successful call.
//
// A fallback that cannot serve the request is strictly worse than none: it
// costs a paid call, adds ~27s of latency, and MASKS the primary's real error
// behind a guaranteed failure. Transcribe already reasons this way in its own
// comment. If a vision-capable fallback is ever configured, restore it
// deliberately — and delete this test on purpose, not by accident.
func TestRouter_IdentifyPhoto_DoesNotFallBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", guessErr: errors.New("gemini exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "blind-fallback-guess", Confidence: 0.9}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	_, _, err := r.IdentifyPhoto(context.Background(), []byte("jpeg-bytes"), "image/jpeg")

	require.Error(t, err, "the primary's real error must surface, not be masked by a blind fallback")
	assert.Contains(t, err.Error(), "gemini exploded")
	assert.Equal(t, 1, primary.calls)
	assert.Equal(t, 0, fallback.calls, "a text-only fallback must never be handed a photo")
}

// TestRouter_IdentifyPhoto_GivesPrimaryTheFullPhotoBudget guards the budget
// itself. photoBudget was 3s — far too short for a multimodal call, which is
// what forced every photo resolve onto the fallback in the first place. The
// stub sleeps past the old 3s value; if photoBudget regresses to anything at
// or below it, this fails.
func TestRouter_IdentifyPhoto_GivesPrimaryTheFullPhotoBudget(t *testing.T) {
	assert.Greater(t, photoBudget, 3*time.Second,
		"3s cannot accommodate a vision call; that budget is what starved the primary")

	primary := &stubProvider{
		name:       "primary-stub",
		guesses:    []Guess{{Food: "omelette", Confidence: 0.9}},
		guessUsage: Usage{Provider: "primary-stub"},
		delay:      50 * time.Millisecond,
	}
	r := &Router{Primary: primary, Fallback: &stubProvider{name: "fallback-stub"}}

	guesses, usage, err := r.IdentifyPhoto(context.Background(), []byte("jpeg-bytes"), "image/jpeg")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "omelette", Confidence: 0.9}}, guesses)
	assert.Equal(t, "primary-stub", usage.Provider)
}
