package providers

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"

	"github.com/tesserix/kora/api/internal/ai"
)

const (
	gatewayCapabilityHeader  = "X-Kora-AI-Capability"
	gatewayContextKindHeader = "X-Kora-AI-Context-Kind"
	gatewayRTKAppliedHeader  = "X-Kora-RTK-Applied"
)

// AgentGatewayProvider routes every model capability through the private Agent
// Gateway. The classification headers are constructed server-side and are
// never copied from an inbound Kora request.
type AgentGatewayProvider struct {
	identify        OpenAIProvider
	photo           OpenAIProvider
	bodyComposition OpenAIProvider
	decompose       OpenAIProvider
	embed           OpenAIProvider
	transcribe      OpenAIProvider
	coach           OpenAIProvider
}

func NewAgentGatewayProvider(apiKey, baseURL, model string) AgentGatewayProvider {
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
		identify: classified("identify_text", "json_api"),
		photo:    classified("identify_photo", "json_api"),
		// "identify_body_composition" is duplicated as a literal here rather
		// than importing providers.callTypeIdentifyBodyComposition — this file
		// already duplicates "identify_photo" etc. the same way, matching the
		// existing convention of the classification header value equaling
		// (but not being wired to) the call-type constant used elsewhere.
		// context kind is "json_api", same as photo: still a single
		// structured JSON response, not audio or embedding.
		bodyComposition: classified("identify_body_composition", "json_api"),
		decompose:       classified("decompose", "json_api"),
		embed:           classified("embedding", "embedding"),
		transcribe:      classified("transcribe", "audio"),
		coach:           classified("coach", "conversation"),
	}
}

func (p AgentGatewayProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	guesses, usage, err := p.identify.IdentifyText(ctx, phrase)
	return guesses, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	guesses, usage, err := p.photo.IdentifyPhoto(ctx, image, mime)
	return guesses, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (ai.BodyCompositionReading, ai.Usage, error) {
	reading, usage, err := p.bodyComposition.IdentifyBodyComposition(ctx, image, mime)
	return reading, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	ingredients, usage, err := p.decompose.Decompose(ctx, dish)
	return ingredients, gatewayUsage(usage), err
}

func (p AgentGatewayProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	started := time.Now()
	response, err := p.embed.client.Embeddings.New(ctx, openai.EmbeddingNewParams{
		Input:          openai.EmbeddingNewParamsInputUnion{OfString: openai.String(text)},
		Model:          p.embed.model,
		Dimensions:     openai.Int(int64(embedOutputDimensionality)),
		EncodingFormat: openai.EmbeddingNewParamsEncodingFormatFloat,
	})
	usage := ai.Usage{
		Provider:  "agentgateway",
		Model:     p.embed.model,
		CallType:  callTypeEmbed,
		LatencyMs: int(time.Since(started).Milliseconds()),
	}
	if response != nil {
		usage.Model = response.Model
		usage.TokensIn = int(response.Usage.PromptTokens)
	}
	if err != nil {
		return nil, usage, fmt.Errorf("agentgateway: embed: %w", err)
	}
	if len(response.Data) == 0 {
		return nil, usage, fmt.Errorf("agentgateway: embed: no embeddings in response")
	}
	embedding := make([]float32, len(response.Data[0].Embedding))
	for index, value := range response.Data[0].Embedding {
		embedding[index] = float32(value)
	}
	return embedding, usage, nil
}

func (p AgentGatewayProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	started := time.Now()
	dataURL := fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(audio))
	response, err := p.transcribe.client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model: p.transcribe.model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(transcribeSystemPrompt),
			openai.UserMessage([]openai.ChatCompletionContentPartUnionParam{
				openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{URL: dataURL}),
			}),
		},
	})
	usage := ai.Usage{
		Provider:  "agentgateway",
		Model:     p.transcribe.model,
		CallType:  callTypeTranscribe,
		LatencyMs: int(time.Since(started).Milliseconds()),
	}
	if response != nil {
		usage.TokensIn = int(response.Usage.PromptTokens)
		usage.TokensOut = int(response.Usage.CompletionTokens)
	}
	if err != nil {
		return "", usage, fmt.Errorf("agentgateway: transcribe: %w", err)
	}
	if len(response.Choices) == 0 {
		return "", usage, fmt.Errorf("agentgateway: transcribe: no choices in response")
	}
	return response.Choices[0].Message.Content, usage, nil
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
