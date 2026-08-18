package ai_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

type generationProvider struct {
	name  string
	text  string
	usage ai.Usage
	err   error
}

func (p generationProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (p generationProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (p generationProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (p generationProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (p generationProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (p generationProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return p.text, p.usage, p.err
}
func (p generationProvider) Name() string { return p.name }

func TestUsageCollectorExposesAbandonedRouterLegsToProviderConsumers(t *testing.T) {
	router := &ai.Router{
		Primary: generationProvider{
			name:  "primary",
			usage: ai.Usage{Provider: "primary", TokensIn: 8},
			err:   errors.New("primary boom"),
		},
		Fallback: generationProvider{
			name:  "fallback",
			text:  "answer",
			usage: ai.Usage{Provider: "fallback", TokensIn: 13},
		},
	}

	ctx, collector := ai.WithUsageCollector(context.Background())
	_, returned, err := router.GenerateText(ctx, "system", "question")

	require.NoError(t, err)
	require.Equal(t, "fallback", returned.Provider)
	abandoned := collector.Drain()
	require.Len(t, abandoned, 1)
	require.Equal(t, "primary", abandoned[0].Provider)
	require.Equal(t, ai.OutcomeError, abandoned[0].Outcome)
}
