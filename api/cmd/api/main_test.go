package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/user"
)

// stubProvider is a minimal ai.Provider whose Embed fails with a recognisable
// error, standing in for Gemini returning (say) a 429. Only Embed is
// exercised; the rest satisfy the interface.
type stubProvider struct{ embedErr error }

func (s stubProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, errors.New("not used")
}

func (s stubProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, errors.New("not used")
}

func (s stubProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, errors.New("not used")
}

func (s stubProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, s.embedErr
}

func (s stubProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, errors.New("not used")
}

func (s stubProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, errors.New("not used")
}

func (s stubProvider) Name() string { return "stub" }

func TestGatewayWiringUsesTheGatewayForRequestsAndEmbeddings(t *testing.T) {
	t.Parallel()

	wiring := gatewayProviders(config.Config{
		AIGatewayEnabled: true,
		AIGatewayBaseURL: "http://agentgateway.kora.svc.cluster.local/v1",
		AIGatewayAPIKey:  "internal-key",
		AIGatewayModel:   "kora-auto",
	})

	assert.IsType(t, providers.AgentGatewayProvider{}, wiring.requests)
	assert.IsType(t, providers.AgentGatewayProvider{}, wiring.embeddings)
}

func TestDirectWiringKeepsEmbeddingsOnGemini(t *testing.T) {
	t.Parallel()

	gemini := providers.GeminiProvider{}

	fallback := directProviders(config.Config{
		OpenAIAPIKey:  "fallback-key",
		OpenAIBaseURL: "https://fallback.invalid/v1",
		OpenAIModel:   "fallback-model",
	}, gemini)
	assert.IsType(t, &ai.Router{}, fallback.requests)
	assert.IsType(t, providers.GeminiProvider{}, fallback.embeddings)

	direct := directProviders(config.Config{}, gemini)
	assert.IsType(t, providers.GeminiProvider{}, direct.requests)
	assert.IsType(t, providers.GeminiProvider{}, direct.embeddings)
}

// TestRouterBackedEmbedderMasksTheRealError is the observable difference that
// makes the wiring above load-bearing rather than stylistic. It demonstrates on
// live code — not by assertion about comments — that routing an embed through
// ai.Router replaces the primary's error with OpenAI's "not supported" string.
//
// That is exactly the error-masking this review wave exists to remove: a Gemini
// 429 logged by nutrition's embedAsync would read as an OpenAI capability
// error, and nobody would ever see the rate limit.
func TestRouterBackedEmbedderMasksTheRealError(t *testing.T) {
	geminiErr := errors.New("gemini: embed: Error 429, Status: RESOURCE_EXHAUSTED")
	primary := stubProvider{embedErr: geminiErr}

	// The direct wiring surfaces the real error verbatim.
	direct := providerEmbedder{p: primary}
	_, err := direct.Embed(context.Background(), "oat milk")
	require.Error(t, err)
	assert.ErrorIs(t, err, geminiErr, "the direct embedder must surface the provider's own error")

	// The Router wiring swallows it and reports OpenAI's refusal instead.
	routed := providerEmbedder{p: &ai.Router{
		Primary:  primary,
		Fallback: providers.NewOpenAIProvider("test-key", "https://example.invalid/v1", "test-model", false),
	}}
	_, routedErr := routed.Embed(context.Background(), "oat milk")
	require.Error(t, routedErr)
	assert.NotErrorIs(t, routedErr, geminiErr, "the Router drops the primary's error — this is the masking that must not reach ingest")
	assert.Contains(t, routedErr.Error(), "openai: embed: not supported",
		"a Router-backed ingest embed reports OpenAI's refusal, hiding the real Gemini failure")
}

// TestNamedTimezonesResolve guards the blank `_ "time/tzdata"` import above.
// Without it the production image has no zoneinfo and every named zone
// silently resolves to UTC, which would put every user's day boundary in the
// wrong place (see user/middleware.go's ResolveMiddleware and
// onboarding/handler.go's target_date derivation, both of which call
// time.LoadLocation on a stored timezone string).
//
// This test passes on macOS and most Linux desktops regardless of the
// import, because the OS itself ships a zoneinfo database that
// time.LoadLocation falls back to. It only proves the import is present (and
// catches its removal) in environments with no OS-level zoneinfo -- CI
// runners and the actual alpine-based container this binary ships in. A
// green run here on a developer machine is not evidence the import works;
// it is evidence the import compiles and the zone names are spelled right.
func TestNamedTimezonesResolve(t *testing.T) {
	for _, name := range []string{"Australia/Sydney", "Asia/Kolkata", "America/New_York", user.DefaultTimezone} {
		loc, err := time.LoadLocation(name)
		require.NoError(t, err, "zone %s must resolve", name)
		require.NotNil(t, loc)
	}
}
