package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A Router with no Fallback is a legitimate shape: production runs Gemini
// alone whenever no OpenAI key is configured. The router used to dereference
// r.Fallback unconditionally inside every fallback closure, so such a Router
// looked healthy right up until the primary first failed and then panicked on
// a nil pointer — replacing the primary's real error, the one thing worth
// seeing, with a runtime panic. These tests pin the degraded behaviour:
// with nobody to fall back TO, the primary's own outcome is the request's.

func TestRouter_NilFallback_IdentifyText_ReturnsPrimaryError(t *testing.T) {
	boom := errors.New("primary exploded")
	primary := &stubProvider{name: "primary-stub", guessErr: boom}
	r := &Router{Primary: primary}

	ctx, collector := WithUsageCollector(context.Background())
	_, usage, err := r.IdentifyText(ctx, "apple")

	require.ErrorIs(t, err, boom, "the primary's error must survive, not become a panic")
	assert.Equal(t, OutcomeError, usage.Outcome)
	assert.Equal(t, 1, primary.calls)
	assert.Empty(t, collector.Drain(),
		"the returned Usage IS the primary's leg; depositing it too would double-count it")
}

func TestRouter_NilFallback_Decompose_ReturnsPrimaryError(t *testing.T) {
	boom := errors.New("primary exploded")
	primary := &stubProvider{name: "primary-stub", ingredientsErr: boom}
	r := &Router{Primary: primary}

	_, usage, err := r.Decompose(context.Background(), "chicken parma")

	require.ErrorIs(t, err, boom)
	assert.Equal(t, OutcomeError, usage.Outcome)
}

func TestRouter_NilFallback_Embed_ReturnsPrimaryError(t *testing.T) {
	boom := errors.New("primary exploded")
	primary := &stubProvider{name: "primary-stub", embedErr: boom}
	r := &Router{Primary: primary}

	_, usage, err := r.Embed(context.Background(), "chicken breast")

	require.ErrorIs(t, err, boom)
	assert.Equal(t, OutcomeError, usage.Outcome)
}

func TestRouter_NilFallback_GenerateText_ReturnsPrimaryError(t *testing.T) {
	boom := errors.New("primary exploded")
	primary := &stubProvider{name: "primary-stub", textErr: boom}
	r := &Router{Primary: primary}

	_, usage, err := r.GenerateText(context.Background(), "system", "user")

	require.ErrorIs(t, err, boom)
	assert.Equal(t, OutcomeError, usage.Outcome)
}

// A blown budget is the other way into the fallback branch, and the one
// production would actually hit first.
func TestRouter_NilFallback_PrimaryTimesOut_DoesNotPanic(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	r := &Router{Primary: primary, TextBudget: 20 * time.Millisecond}

	_, usage, err := r.IdentifyText(context.Background(), "apple")

	require.Error(t, err)
	assert.Equal(t, OutcomeTimeout, usage.Outcome)
}

func TestRouter_NilFallback_PrimarySucceeds(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		guesses:    []Guess{{Food: "apple", Confidence: 0.9}},
		guessUsage: Usage{Provider: "primary-stub"},
	}
	r := &Router{Primary: primary}

	guesses, usage, err := r.IdentifyText(context.Background(), "apple")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "apple", Confidence: 0.9}}, guesses)
	assert.Equal(t, OutcomeOK, usage.Outcome)
}

func TestRouter_NilFallback_Name(t *testing.T) {
	r := &Router{Primary: &stubProvider{name: "gemini"}}
	assert.Equal(t, "router(gemini)", r.Name(),
		"Name must describe a fallback-less Router rather than panic on every call")
}

// NewRouter exists so the invalid shape cannot be built at the call site that
// matters: with no fallback there is nothing for a Router to add, so it hands
// back the bare primary — exactly what cmd/api used to open-code.
func TestNewRouter_NilFallback_ReturnsBarePrimary(t *testing.T) {
	primary := &stubProvider{name: "gemini"}

	got := NewRouter(primary, nil)

	assert.Same(t, primary, got, "no fallback means no Router is warranted")
}

func TestNewRouter_WithFallback_ReturnsRouter(t *testing.T) {
	primary := &stubProvider{name: "gemini"}
	fallback := &stubProvider{name: "openai"}

	got := NewRouter(primary, fallback)

	r, ok := got.(*Router)
	require.True(t, ok, "a configured fallback must produce a Router")
	assert.Same(t, primary, r.Primary)
	assert.Same(t, fallback, r.Fallback)
}

// A nil Primary is the one shape a Router genuinely cannot serve. NewRouter
// rejects it at wiring time rather than letting it surface as a nil
// dereference inside a closure on the first request.
func TestNewRouter_NilPrimary_Panics(t *testing.T) {
	assert.PanicsWithValue(t, "ai: NewRouter requires a non-nil primary provider", func() {
		NewRouter(nil, &stubProvider{name: "openai"})
	})
}

func TestNewRouter_NilPrimaryAndFallback_Panics(t *testing.T) {
	assert.PanicsWithValue(t, "ai: NewRouter requires a non-nil primary provider", func() {
		NewRouter(nil, nil)
	})
}
