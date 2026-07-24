package ai

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// stubProvider is a configurable Provider test double. The zero value
// behaves like a minimal no-op stub (used to verify the interface shape
// compiles and is satisfiable without live calls); router_test.go configures
// its fields to exercise success, error, and latency-fallback paths.
type stubProvider struct {
	name string

	guesses    []Guess
	guessUsage Usage
	guessErr   error

	ingredients      []IngredientGuess
	ingredientsUsage Usage
	ingredientsErr   error

	embedding  []float32
	embedUsage Usage
	embedErr   error

	// block, when true, makes every method wait on ctx.Done() and return
	// ctx.Err() instead of its configured result — simulates a provider
	// call that runs past its latency budget.
	block bool

	// delay, when > 0 and block is false, makes every method sleep for delay
	// (respecting ctx) before returning its configured result — simulates a
	// slow-but-succeeding provider (e.g. the NVIDIA fallback's cold start).
	delay time.Duration

	// calls counts every method invocation, for asserting a provider was
	// (not) reached.
	calls int
}

func (s *stubProvider) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	s.calls++
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, Usage{}, ctx.Err()
		}
	}
	if s.block {
		<-ctx.Done()
		return nil, Usage{}, ctx.Err()
	}
	return s.guesses, s.guessUsage, s.guessErr
}

func (s *stubProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	s.calls++
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, Usage{}, ctx.Err()
		}
	}
	if s.block {
		<-ctx.Done()
		return nil, Usage{}, ctx.Err()
	}
	return s.guesses, s.guessUsage, s.guessErr
}

func (s *stubProvider) Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error) {
	s.calls++
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, Usage{}, ctx.Err()
		}
	}
	if s.block {
		<-ctx.Done()
		return nil, Usage{}, ctx.Err()
	}
	return s.ingredients, s.ingredientsUsage, s.ingredientsErr
}

func (s *stubProvider) Embed(ctx context.Context, text string) ([]float32, Usage, error) {
	s.calls++
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, Usage{}, ctx.Err()
		}
	}
	if s.block {
		<-ctx.Done()
		return nil, Usage{}, ctx.Err()
	}
	return s.embedding, s.embedUsage, s.embedErr
}

func (s *stubProvider) Name() string {
	if s.name != "" {
		return s.name
	}
	return "stub"
}

var _ Provider = (*stubProvider)(nil)

func TestTierFor(t *testing.T) {
	tests := []struct {
		name         string
		identifyConf float64
		matchScore   float64
		expectTier   Tier
	}{
		{
			name:         "0.95 identify and match is auto",
			identifyConf: 0.95,
			matchScore:   0.95,
			expectTier:   TierAuto,
		},
		{
			name:         "0.8 identify and match is confirm",
			identifyConf: 0.8,
			matchScore:   0.8,
			expectTier:   TierConfirm,
		},
		{
			name:         "0.5 identify and match is follow_up",
			identifyConf: 0.5,
			matchScore:   0.5,
			expectTier:   TierFollowUp,
		},
		{
			name:         "min wins: identify 0.95 but match 0.6 is follow_up",
			identifyConf: 0.95,
			matchScore:   0.6,
			expectTier:   TierFollowUp,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := TierFor(tt.identifyConf, tt.matchScore)
			assert.Equal(t, tt.expectTier, got, "TierFor(%v, %v)", tt.identifyConf, tt.matchScore)
		})
	}
}
