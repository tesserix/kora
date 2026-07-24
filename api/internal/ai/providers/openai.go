package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/shared"

	"github.com/tesserix/kora/api/internal/ai"
)

// modelGPT5Mini is the fallback model for identify/decompose. It is a plain
// string (shared.ChatModel is a string alias) rather than an SDK constant:
// the installed openai-go SDK (v1.12.0) predates GPT-5 in its generated
// model-ID const list, but the Chat Completions API accepts any valid model
// ID string, so this does not block using it.
const modelGPT5Mini = "gpt-5-mini"

// OpenAIProvider implements ai.Provider as the OpenAI-COMPATIBLE FALLBACK
// backend for IdentifyText/IdentifyPhoto/Decompose. Embed is deliberately
// NOT backed by a live OpenAI call — see Embed's doc comment for why.
type OpenAIProvider struct {
	client     openai.Client
	model      string
	jsonObject bool
}

// NewOpenAIProvider builds the OpenAI-compatible FALLBACK provider. baseURL,
// when non-empty, points the client at any OpenAI-compatible endpoint (e.g.
// NVIDIA NIM at https://integrate.api.nvidia.com/v1). model overrides the
// default gpt-5-mini. jsonObject selects response_format:{type:"json_object"}
// for endpoints that don't support strict json_schema well (NVIDIA's llama
// models: strict schema is slow (~29s) and yields degenerate values, so the
// schema shape is instead described in the prompt and enforced by parsing).
func NewOpenAIProvider(apiKey, baseURL, model string, jsonObject bool) OpenAIProvider {
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	if model == "" {
		model = modelGPT5Mini
	}
	return OpenAIProvider{client: openai.NewClient(opts...), model: model, jsonObject: jsonObject}
}

// modelDefault returns p's configured model — a small accessor so tests can
// build params for the model buildParams' callers would use without
// duplicating the field access.
func modelDefault(p OpenAIProvider) string { return p.model }

// Name identifies this provider for Usage records.
func (OpenAIProvider) Name() string { return "openai" }

// guessJSONSchema builds the Structured Outputs JSON schema constraining
// identify responses to identity + portion + confidence ONLY — the same
// invariant boundary as Gemini's guessResponseSchema, expressed as a plain
// map because openai-go's ResponseFormatJSONSchemaJSONSchemaParam.Schema is
// typed `any` (raw JSON Schema), not an SDK schema builder type.
//
// The root must be a JSON object (OpenAI's Structured Outputs does not
// support a bare array at the top level), so the guess array is nested under
// a "guesses" key; unwrapGuesses restores the bare-array shape the shared
// parseGuesses helper expects. strict:true requires every property listed
// and additionalProperties:false at every object level, which is set below.
func guessJSONSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"guesses": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"food":             map[string]any{"type": "string"},
						"portion_estimate": map[string]any{"type": "string"},
						"cooking_method":   map[string]any{"type": "string"},
						"confidence":       map[string]any{"type": "number"},
					},
					"required":             []string{"food", "portion_estimate", "cooking_method", "confidence"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"guesses"},
		"additionalProperties": false,
	}
}

// ingredientJSONSchema is guessJSONSchema's counterpart for Decompose:
// identity + portion + confidence only, no cooking method, no nutrition
// number. See guessJSONSchema for the object-root/unwrap rationale.
func ingredientJSONSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"ingredients": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"ingredient":       map[string]any{"type": "string"},
						"portion_estimate": map[string]any{"type": "string"},
						"confidence":       map[string]any{"type": "number"},
					},
					"required":             []string{"ingredient", "portion_estimate", "confidence"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"ingredients"},
		"additionalProperties": false,
	}
}

// guessesEnvelope/ingredientsEnvelope unwrap the object-root Structured
// Outputs payload down to the bare JSON array the shared
// parseGuesses/parseIngredients helpers (defined in gemini.go) expect. Using
// json.RawMessage defers decoding the array elements to those helpers, so
// the element-shape parsing logic lives in exactly one place.
type guessesEnvelope struct {
	Guesses json.RawMessage `json:"guesses"`
}

type ingredientsEnvelope struct {
	Ingredients json.RawMessage `json:"ingredients"`
}

func unwrapGuesses(data []byte) ([]byte, error) {
	var env guessesEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("unwrap guesses envelope: %w", err)
	}
	return env.Guesses, nil
}

func unwrapIngredients(data []byte) ([]byte, error) {
	var env ingredientsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("unwrap ingredients envelope: %w", err)
	}
	return env.Ingredients, nil
}

// IdentifyText identifies foods from a free-text phrase using the
// configured model.
func (p OpenAIProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	data, usage, err := p.generateJSON(ctx, p.model, callTypeIdentifyText,
		identifySystemPrompt, []openai.ChatCompletionContentPartUnionParam{openai.TextContentPart(phrase)},
		"food_guesses", guessJSONSchema())
	if err != nil {
		return nil, usage, err
	}
	arr, err := unwrapGuesses(data)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: identify text: %w", err)
	}
	guesses, err := parseGuesses(arr)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: identify text: parse response: %w", err)
	}
	return guesses, usage, nil
}

// IdentifyPhoto identifies foods from a photo using the configured model's
// vision input (an image_url content part with a base64 data: URL).
func (p OpenAIProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	dataURL := fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(image))
	data, usage, err := p.generateJSON(ctx, p.model, callTypeIdentifyPhoto,
		identifySystemPrompt,
		[]openai.ChatCompletionContentPartUnionParam{
			openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{URL: dataURL}),
		},
		"food_guesses", guessJSONSchema())
	if err != nil {
		return nil, usage, err
	}
	arr, err := unwrapGuesses(data)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: identify photo: %w", err)
	}
	guesses, err := parseGuesses(arr)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: identify photo: parse response: %w", err)
	}
	return guesses, usage, nil
}

// Decompose breaks a dish into its ingredients using the configured model.
func (p OpenAIProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	prompt := fmt.Sprintf(decomposeSystemPromptTmpl, dish)
	data, usage, err := p.generateJSON(ctx, p.model, callTypeDecompose,
		prompt, []openai.ChatCompletionContentPartUnionParam{openai.TextContentPart(dish)},
		"dish_ingredients", ingredientJSONSchema())
	if err != nil {
		return nil, usage, err
	}
	arr, err := unwrapIngredients(data)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: decompose: %w", err)
	}
	ingredients, err := parseIngredients(arr)
	if err != nil {
		return nil, usage, fmt.Errorf("openai: decompose: parse response: %w", err)
	}
	return ingredients, usage, nil
}

// Embed is intentionally NOT implemented against a live OpenAI embedding
// model. The nutrition index's similarity tier is populated entirely with
// Gemini's text-embedding-004 vectors; mixing in vectors from a different
// embedding model would corrupt cosine search even if the OpenAI model were
// configured (via the `dimensions` param on text-embedding-3-*) to emit
// 768-dim output. Matching dimensionality is NOT the same as a compatible
// vector space — two different models' embeddings are not comparable by
// cosine similarity just because they happen to have the same length, since
// each model's vectors live in its own learned geometry. So embeddings stay
// on the primary (Gemini) provider; the router must not fall back Embed
// calls to OpenAI. This returns a clear error rather than silently
// producing a vector that would poison the index.
func (p OpenAIProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, fmt.Errorf(
		"openai: embed: not supported — embeddings stay on Gemini (text-embedding-004) " +
			"to avoid mixing incompatible vector spaces in the nutrition index's cosine search")
}

// jsonObjectSchemaHint renders a compact description of a JSON schema's shape
// for embedding in a system prompt when json_object mode can't enforce the
// schema server-side. It lists the required top-level key and item fields.
func jsonObjectSchemaHint(schema map[string]any) string {
	b, _ := json.Marshal(schema)
	return "Respond with a single JSON object matching exactly this JSON Schema " +
		"(no extra keys, no nutrition/calorie/macro numbers): " + string(b)
}

// buildParams constructs the Chat Completions request params for a single
// generateJSON call. It is pure (no network call) so tests can assert on the
// request shape directly. In strict mode (jsonObject == false) it is
// byte-for-byte the same request shape as before this adapter became
// configurable: a json_schema response format with the untouched system
// prompt. In compat mode (jsonObject == true) it switches to a json_object
// response format — which does not enforce a schema server-side — and
// compensates by appending a description of the expected shape to the
// system prompt; see generateJSON's doc comment for why the schema itself
// remains the actual invariant boundary regardless of response format.
func (p OpenAIProvider) buildParams(
	model, systemPrompt string,
	userParts []openai.ChatCompletionContentPartUnionParam,
	schemaName string,
	schema map[string]any,
) openai.ChatCompletionNewParams {
	sys := systemPrompt
	var rf openai.ChatCompletionNewParamsResponseFormatUnion
	if p.jsonObject {
		sys = systemPrompt + " " + jsonObjectSchemaHint(schema)
		jo := shared.NewResponseFormatJSONObjectParam()
		rf = openai.ChatCompletionNewParamsResponseFormatUnion{OfJSONObject: &jo}
	} else {
		rf = openai.ChatCompletionNewParamsResponseFormatUnion{
			OfJSONSchema: &shared.ResponseFormatJSONSchemaParam{
				JSONSchema: shared.ResponseFormatJSONSchemaJSONSchemaParam{
					Name:   schemaName,
					Strict: openai.Bool(true),
					Schema: schema,
				},
			},
		}
	}
	return openai.ChatCompletionNewParams{
		Model: model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(sys),
			openai.UserMessage(userParts),
		},
		ResponseFormat: rf,
	}
}

// generateJSON is the shared SDK glue for IdentifyText/IdentifyPhoto/
// Decompose: it calls Chat Completions with a JSON-constrained response
// format (see buildParams) and returns the raw response text for the
// caller's unwrap+parse steps, plus a populated Usage. The schema is the
// sole invariant boundary — no nutrition field is ever a valid property, so
// the model structurally cannot return one no matter what the prompt says —
// EXCEPT in compat mode, where json_object does not enforce the schema
// server-side and the boundary is instead enforced at parse time by
// parseGuesses/parseIngredients, which decode only identity/portion/
// confidence fields and silently drop anything else.
func (p OpenAIProvider) generateJSON(
	ctx context.Context,
	model string,
	callType string,
	systemPrompt string,
	userParts []openai.ChatCompletionContentPartUnionParam,
	schemaName string,
	schema map[string]any,
) ([]byte, ai.Usage, error) {
	start := time.Now()

	params := p.buildParams(model, systemPrompt, userParts, schemaName, schema)

	resp, err := p.client.Chat.Completions.New(ctx, params)

	usage := ai.Usage{
		Provider:  p.Name(),
		Model:     model,
		CallType:  callType,
		LatencyMs: int(time.Since(start).Milliseconds()),
	}
	if resp != nil {
		usage.TokensIn = int(resp.Usage.PromptTokens)
		usage.TokensOut = int(resp.Usage.CompletionTokens)
	}
	if err != nil {
		return nil, usage, fmt.Errorf("openai: chat completion: %w", err)
	}
	if len(resp.Choices) == 0 {
		return nil, usage, fmt.Errorf("openai: chat completion: no choices in response")
	}

	return []byte(resp.Choices[0].Message.Content), usage, nil
}

// Compile-time assertion that OpenAIProvider satisfies ai.Provider.
var _ ai.Provider = OpenAIProvider{}
