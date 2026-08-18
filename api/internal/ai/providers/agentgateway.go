package providers

import (
	"context"

	"github.com/openai/openai-go/option"

	"github.com/tesserix/kora/api/internal/ai"
)

const (
	gatewayCapabilityHeader  = "X-Kora-AI-Capability"
	gatewayContextKindHeader = "X-Kora-AI-Context-Kind"
	gatewayRTKAppliedHeader  = "X-Kora-RTK-Applied"
)

// AgentGatewayProvider routes text and structured generation through the
// private Agent Gateway while keeping embeddings and multimodal calls on the
// concrete Vertex/Gemini provider. The classification headers are constructed
// server-side and are never copied from an inbound Kora request.
type AgentGatewayProvider struct {
	direct    ai.Provider
	identify  OpenAIProvider
	decompose OpenAIProvider
	coach     OpenAIProvider
}

func NewAgentGatewayProvider(direct ai.Provider, apiKey, baseURL, model string) AgentGatewayProvider {
	classified := func(capability, contextKind string) OpenAIProvider {
		return newOpenAIProvider(
			apiKey,
			baseURL,
			model,
			false,
			option.WithHeader(gatewayCapabilityHeader, capability),
			option.WithHeader(gatewayContextKindHeader, contextKind),
			option.WithHeader(gatewayRTKAppliedHeader, "false"),
		)
	}
	return AgentGatewayProvider{
		direct:    direct,
		identify:  classified("identify_text", "json_api"),
		decompose: classified("decompose", "json_api"),
		coach:     classified("coach", "conversation"),
	}
}

func (p AgentGatewayProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	guesses, usage, err := p.identify.IdentifyText(ctx, phrase)
	return guesses, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	return p.direct.IdentifyPhoto(ctx, image, mime)
}

func (p AgentGatewayProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	ingredients, usage, err := p.decompose.Decompose(ctx, dish)
	return ingredients, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	return p.direct.Embed(ctx, text)
}

func (p AgentGatewayProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return p.direct.Transcribe(ctx, audio, mime)
}

func (p AgentGatewayProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	response, usage, err := p.coach.GenerateText(ctx, systemPrompt, userPrompt)
	return response, gatewayUsage(usage), err
}

func (AgentGatewayProvider) Name() string { return "agentgateway" }

func gatewayUsage(usage ai.Usage) ai.Usage {
	usage.Provider = "agentgateway"
	return usage
}
