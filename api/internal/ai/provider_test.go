package ai

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

// stubProvider is a minimal Provider implementation used to verify the
// interface shape compiles and is satisfiable without live calls.
type stubProvider struct{}

func (s *stubProvider) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	return nil, Usage{}, nil
}

func (s *stubProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	return nil, Usage{}, nil
}

func (s *stubProvider) Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error) {
	return nil, Usage{}, nil
}

func (s *stubProvider) Embed(ctx context.Context, text string) ([]float32, Usage, error) {
	return nil, Usage{}, nil
}

func (s *stubProvider) Name() string {
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
