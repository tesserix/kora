// Package providers holds concrete ai.Provider implementations — thin
// adapters over specific LLM SDKs. Higher layers (ai.Resolver) never import
// this package directly; they depend only on ai.Provider, so a provider swap
// (Gemini -> OpenAI) never touches resolution logic.
package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"google.golang.org/genai"

	"github.com/tesserix/kora/api/internal/ai"
)

// Model IDs. Flash-Lite handles text identify and decompose (cheap, no
// image); Flash handles photo identify (multimodal); the embedding model
// produces 768-dim vectors used for the nutrition index's similarity tier.
const (
	modelFlash     = "gemini-3.5-flash"
	modelFlashLite = "gemini-3.5-flash-lite"
	modelEmbed     = "gemini-embedding-001"
)

// embedOutputDimensionality is the embedding vector width requested from
// modelEmbed. It MUST match the nutrition index's vector(768) column — the
// SDK truncates the model's native embedding to this length server-side.
const embedOutputDimensionality int32 = 768

// Call types recorded on ai.Usage, matching the doc comment on Usage.CallType.
const (
	callTypeIdentifyText  = "identify_text"
	callTypeIdentifyPhoto = "identify_photo"
	callTypeDecompose     = "decompose"
	callTypeEmbed         = "embed"
	callTypeTranscribe    = "transcribe"
	callTypeCoach         = "coach"
)

const (
	identifySystemPrompt = "You identify foods from a description or photo. " +
		"For each distinct food you see or read about, report its name, an " +
		"estimated portion (a short human phrase like \"1 cup\" or \"150g\"), " +
		"the cooking method if apparent (e.g. \"grilled\", \"raw\", \"fried\"), " +
		"and your confidence (0.0-1.0) that the identification is correct. " +
		"Do NOT estimate or state any calorie, macro, or other nutrition number " +
		"— nutrition values are looked up separately and any number you " +
		"provide would be ignored and could mislead. Respond with JSON only, " +
		"matching the provided schema."

	decomposeSystemPromptTmpl = "Decompose the dish %q into its distinct " +
		"ingredients. For each ingredient, report its name and an estimated " +
		"portion (a short human phrase like \"1 tbsp\" or \"50g\") as consumed " +
		"in this dish, and your confidence (0.0-1.0) in that estimate. Do NOT " +
		"estimate or state any calorie, macro, or other nutrition number — " +
		"nutrition values are looked up separately and any number you provide " +
		"would be ignored and could mislead. Respond with JSON only, matching " +
		"the provided schema."

	transcribeSystemPrompt = "You transcribe short audio clips of a person " +
		"describing what they ate. Return ONLY the spoken words as plain text — " +
		"no commentary, no punctuation cleanup beyond what's spoken, and never " +
		"any calorie or nutrition number. If the audio contains no discernible " +
		"speech, return an empty string."
)

// GeminiProvider implements ai.Provider over the Gemini API via
// google.golang.org/genai.
type GeminiProvider struct {
	client *genai.Client
}

// NewGeminiProvider builds a GeminiProvider authenticated with apiKey against
// the Gemini API backend (not Vertex AI).
func NewGeminiProvider(ctx context.Context, apiKey string) (GeminiProvider, error) {
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return GeminiProvider{}, fmt.Errorf("gemini: new client: %w", err)
	}
	return GeminiProvider{client: client}, nil
}

// Name identifies this provider for Usage records.
func (GeminiProvider) Name() string { return "gemini" }

// guessResponseSchema builds the JSON schema constraining identify responses
// to identity + portion + confidence ONLY. It deliberately has no property
// for any nutrition number (kcal/protein/carbs/fat) — this is the schema
// boundary that enforces the "LLM never supplies nutrition numbers"
// invariant, independent of prompt wording.
func guessResponseSchema() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeArray,
		Items: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"food":             {Type: genai.TypeString},
				"portion_estimate": {Type: genai.TypeString},
				"cooking_method":   {Type: genai.TypeString},
				"confidence":       {Type: genai.TypeNumber},
			},
			Required: []string{"food", "portion_estimate", "cooking_method", "confidence"},
		},
	}
}

// ingredientResponseSchema is guessResponseSchema's counterpart for
// Decompose: identity + portion + confidence only, no cooking method (not
// meaningful per-ingredient) and no nutrition number.
func ingredientResponseSchema() *genai.Schema {
	return &genai.Schema{
		Type: genai.TypeArray,
		Items: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"ingredient":       {Type: genai.TypeString},
				"portion_estimate": {Type: genai.TypeString},
				"confidence":       {Type: genai.TypeNumber},
			},
			Required: []string{"ingredient", "portion_estimate", "confidence"},
		},
	}
}

// IdentifyText identifies foods from a free-text phrase using Flash-Lite.
func (p GeminiProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	data, usage, err := p.generateJSON(ctx, modelFlashLite, callTypeIdentifyText,
		identifySystemPrompt, []*genai.Part{genai.NewPartFromText(phrase)}, guessResponseSchema())
	if err != nil {
		return nil, usage, err
	}
	guesses, err := parseGuesses(data)
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: identify text: parse response: %w", err)
	}
	return guesses, usage, nil
}

// IdentifyPhoto identifies foods from a photo using Flash (multimodal).
func (p GeminiProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	data, usage, err := p.generateJSON(ctx, modelFlash, callTypeIdentifyPhoto,
		identifySystemPrompt, []*genai.Part{genai.NewPartFromBytes(image, mime)}, guessResponseSchema())
	if err != nil {
		return nil, usage, err
	}
	guesses, err := parseGuesses(data)
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: identify photo: parse response: %w", err)
	}
	return guesses, usage, nil
}

// Decompose breaks a dish into its ingredients using Flash-Lite.
func (p GeminiProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	prompt := fmt.Sprintf(decomposeSystemPromptTmpl, dish)
	data, usage, err := p.generateJSON(ctx, modelFlashLite, callTypeDecompose,
		prompt, []*genai.Part{genai.NewPartFromText(dish)}, ingredientResponseSchema())
	if err != nil {
		return nil, usage, err
	}
	ingredients, err := parseIngredients(data)
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: decompose: parse response: %w", err)
	}
	return ingredients, usage, nil
}

// Embed produces a 768-dim embedding for text using gemini-embedding-001.
// OutputDimensionality is set explicitly because the model's native output
// is wider than 768 dims — without it, values would not match the index's
// vector(768) column.
func (p GeminiProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	start := time.Now()
	dim := embedOutputDimensionality
	cfg := &genai.EmbedContentConfig{OutputDimensionality: &dim}
	resp, err := p.client.Models.EmbedContent(ctx, modelEmbed,
		[]*genai.Content{genai.NewContentFromText(text, "")}, cfg)
	usage := ai.Usage{
		Provider:  p.Name(),
		Model:     modelEmbed,
		CallType:  callTypeEmbed,
		LatencyMs: int(time.Since(start).Milliseconds()),
	}
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: embed: %w", err)
	}
	if len(resp.Embeddings) == 0 {
		return nil, usage, fmt.Errorf("gemini: embed: no embeddings in response")
	}
	return resp.Embeddings[0].Values, usage, nil
}

// Transcribe converts spoken audio to text using the multimodal Flash model.
// The transcript is later treated as a search phrase, so this returns plain
// text with no schema — the identity/nutrition invariants are enforced
// downstream by the identify/decompose schemas, not here.
func (p GeminiProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	start := time.Now()
	cfg := &genai.GenerateContentConfig{
		SystemInstruction: &genai.Content{Parts: []*genai.Part{genai.NewPartFromText(transcribeSystemPrompt)}},
	}
	resp, err := p.client.Models.GenerateContent(ctx, modelFlash,
		[]*genai.Content{genai.NewContentFromParts([]*genai.Part{genai.NewPartFromBytes(audio, mime)}, genai.RoleUser)}, cfg)
	usage := ai.Usage{Provider: p.Name(), Model: modelFlash, CallType: callTypeTranscribe, LatencyMs: int(time.Since(start).Milliseconds())}
	if resp != nil && resp.UsageMetadata != nil {
		usage.TokensIn = int(resp.UsageMetadata.PromptTokenCount)
		usage.TokensOut = int(resp.UsageMetadata.CandidatesTokenCount)
	}
	if err != nil {
		return "", usage, fmt.Errorf("gemini: transcribe: %w", err)
	}
	return strings.TrimSpace(resp.Text()), usage, nil
}

// GenerateText produces a free-form text response (no JSON schema) using
// Flash, for conversational/coaching use cases. Unlike generateJSON's
// callers, the response is not parsed against any schema — the caller gets
// the model's prose back as-is.
func (p GeminiProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	start := time.Now()
	cfg := &genai.GenerateContentConfig{
		SystemInstruction: &genai.Content{Parts: []*genai.Part{genai.NewPartFromText(systemPrompt)}},
	}
	resp, err := p.client.Models.GenerateContent(ctx, modelFlash,
		[]*genai.Content{genai.NewContentFromParts([]*genai.Part{genai.NewPartFromText(userPrompt)}, genai.RoleUser)}, cfg)
	usage := ai.Usage{Provider: p.Name(), Model: modelFlash, CallType: callTypeCoach, LatencyMs: int(time.Since(start).Milliseconds())}
	if resp != nil && resp.UsageMetadata != nil {
		usage.TokensIn = int(resp.UsageMetadata.PromptTokenCount)
		usage.TokensOut = int(resp.UsageMetadata.CandidatesTokenCount)
	}
	if err != nil {
		return "", usage, fmt.Errorf("gemini: generate text: %w", err)
	}
	return strings.TrimSpace(resp.Text()), usage, nil
}

// generateJSON is the shared SDK glue for IdentifyText/IdentifyPhoto/
// Decompose: it calls GenerateContent with a JSON response schema and
// returns the raw response text for the caller's pure parse helper, plus a
// populated Usage. The schema is the sole invariant boundary — no nutrition
// field is ever a valid property, so the model structurally cannot return
// one no matter what the prompt says.
func (p GeminiProvider) generateJSON(
	ctx context.Context,
	model string,
	callType string,
	systemPrompt string,
	userParts []*genai.Part,
	schema *genai.Schema,
) ([]byte, ai.Usage, error) {
	start := time.Now()

	cfg := &genai.GenerateContentConfig{
		// Built directly (not via NewContentFromParts) so Role stays empty:
		// a system instruction is not a conversation turn, so it should not
		// be tagged "user" — this matches the SDK's own examples.
		SystemInstruction: &genai.Content{Parts: []*genai.Part{genai.NewPartFromText(systemPrompt)}},
		ResponseMIMEType:  "application/json",
		ResponseSchema:    schema,
	}

	resp, err := p.client.Models.GenerateContent(ctx, model,
		[]*genai.Content{genai.NewContentFromParts(userParts, genai.RoleUser)}, cfg)

	usage := ai.Usage{
		Provider:  p.Name(),
		Model:     model,
		CallType:  callType,
		LatencyMs: int(time.Since(start).Milliseconds()),
	}
	if resp != nil && resp.UsageMetadata != nil {
		usage.TokensIn = int(resp.UsageMetadata.PromptTokenCount)
		usage.TokensOut = int(resp.UsageMetadata.CandidatesTokenCount)
	}
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: generate content: %w", err)
	}

	return []byte(resp.Text()), usage, nil
}

// parseGuesses decodes the model's JSON array response into []ai.Guess. It
// is a pure function (no SDK/network dependency) so it can be unit-tested
// directly against hand-written sample JSON.
func parseGuesses(data []byte) ([]ai.Guess, error) {
	var guesses []ai.Guess
	if err := json.Unmarshal(data, &guesses); err != nil {
		return nil, fmt.Errorf("parse guesses: %w", err)
	}
	return guesses, nil
}

// parseIngredients decodes the model's JSON array response into
// []ai.IngredientGuess. Pure, unit-testable — see parseGuesses.
func parseIngredients(data []byte) ([]ai.IngredientGuess, error) {
	var ingredients []ai.IngredientGuess
	if err := json.Unmarshal(data, &ingredients); err != nil {
		return nil, fmt.Errorf("parse ingredients: %w", err)
	}
	return ingredients, nil
}

// Compile-time assertion that GeminiProvider satisfies ai.Provider.
var _ ai.Provider = GeminiProvider{}
