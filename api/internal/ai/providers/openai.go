package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/packages/param"
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
	options    func(context.Context) []option.RequestOption
}

// NewOpenAIProvider builds the OpenAI-compatible FALLBACK provider. baseURL,
// when non-empty, points the client at any OpenAI-compatible endpoint (e.g.
// NVIDIA NIM at https://integrate.api.nvidia.com/v1). model overrides the
// default gpt-5-mini. jsonObject selects response_format:{type:"json_object"}
// for endpoints that don't support strict json_schema well (NVIDIA's llama
// models: strict schema is slow (~29s) and yields degenerate values, so the
// schema shape is instead described in the prompt and enforced by parsing).
func NewOpenAIProvider(apiKey, baseURL, model string, jsonObject bool) OpenAIProvider {
	return newOpenAIProvider(apiKey, baseURL, model, jsonObject)
}

func newOpenAIProvider(apiKey, baseURL, model string, jsonObject bool, extraOptions ...option.RequestOption) OpenAIProvider {
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	opts = append(opts, extraOptions...)
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
						"brand":            map[string]any{"type": "string"},
						"qualifiers":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
						"portion_estimate": map[string]any{"type": "string"},
						"cooking_method":   map[string]any{"type": "string"},
						"confidence":       map[string]any{"type": "number"},
					},
					// Every property must appear in "required" under
					// strict:true, so brand and qualifiers are listed here for
					// the same reason as in Gemini's schema: an omitted brand
					// is indistinguishable from a stated absence, and the
					// absence is load-bearing.
					"required":             []string{"food", "brand", "qualifiers", "portion_estimate", "cooking_method", "confidence"},
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
		"food_guesses", guessJSONSchema(), param.Opt[float64]{})
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
		"food_guesses", guessJSONSchema(), param.Opt[float64]{})
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

// bodyCompositionJSONSchema builds the Structured Outputs JSON schema for
// IdentifyBodyComposition. Unlike guessJSONSchema/ingredientJSONSchema, the
// root here IS the reading object itself — no "guesses"/"ingredients"
// envelope key, because a single reading (not an array of them) is the
// natural top-level shape and OpenAI's Structured Outputs supports an
// object root directly.
//
// Every property is typed nullable (`["number", "null"]` or
// `["string", "null"]` for reading_date_text) AND listed in "required". This
// looks contradictory at first glance — "required" usually means "must be
// present with a value" — but under strict:true, Structured Outputs has no
// other way to express "optional": every property MUST appear in
// "required", full stop, so a field that the model may legitimately be
// unable to read has to be expressed as "required to be present, but its
// value may be JSON null" rather than "absent from the object". The system
// prompt (bodyCompositionSystemPrompt) tells the model to answer null for
// anything not legible on screen, which together with this schema shape
// satisfies both the strict-mode constraint and the "omit what you can't
// read" invariant. Compare guessJSONSchema's comment, which anticipates the
// same kind of reader confusion for its own required list.
func bodyCompositionJSONSchema() map[string]any {
	numberOrNull := func(description string) map[string]any {
		return map[string]any{"type": []string{"number", "null"}, "description": description}
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"weight_kg": numberOrNull("Body weight in kilograms, as displayed. Convert from " +
				"pounds if the screen shows lb (1 lb = 0.453592 kg) — that is unit " +
				"conversion of the one displayed number, not inference."),
			"body_fat_pct": numberOrNull("Body fat PERCENTAGE only. If the screen also shows a " +
				"fat mass in kilograms, ignore that number — report only the percentage here."),
			"subcutaneous_fat_pct": numberOrNull("Subcutaneous fat percentage, if the screen " +
				"labels one separately from body_fat_pct."),
			"visceral_fat_rating": numberOrNull("The scale's own visceral fat RATING exactly as " +
				"displayed — usually a small bare number like 7, or a value on a 1-59 scale. " +
				"This is a vendor rating, not a percentage: report it even with no percent " +
				"sign shown, and never treat it as one."),
			"skeletal_muscle_pct": numberOrNull("Skeletal muscle PERCENTAGE. Distinct from " +
				"muscle_mass_kg — some scales show both; report each only if its own value " +
				"is on screen, never derive one from the other."),
			"muscle_mass_kg": numberOrNull("Muscle mass in kilograms — return this ONLY if the " +
				"screen labels a value as TOTAL muscle mass. A kg figure labelled SKELETAL " +
				"muscle mass is a DIFFERENT, SMALLER quantity (skeletal muscle is a subset of " +
				"total muscle) and reporting it here is a measurement error: many scale apps " +
				"(Omron included) show only a skeletal-muscle kg figure and never a " +
				"total-muscle one, so on those screens this field MUST be null even though a " +
				"muscle-shaped kg number is visible."),
			"body_water_pct": numberOrNull("Body water percentage, as displayed."),
			"protein_pct":    numberOrNull("Protein percentage, as displayed."),
			"bone_mass_kg": numberOrNull("Bone MASS in kilograms as the scale reports it — NOT " +
				"bone density, a T-score, or a BMD number. If the screen shows only a density " +
				"or T-score, use null."),
			"scale_bmr_kcal": numberOrNull("The scale's own estimated basal metabolic rate in " +
				"kilocalories, if shown."),
			"reading_date_text": map[string]any{
				"type": []string{"string", "null"},
				"description": "The date TEXT EXACTLY AS PRINTED on screen for this reading — " +
					"copy it verbatim, character for character (\"22/08\", \"Sat, 22/08\", " +
					"\"2026-08-22\", whatever the screen actually shows). Do NOT reformat it " +
					"to YYYY-MM-DD, do NOT add a year that is not printed, and do NOT compute " +
					"or guess a year — a separate, non-model step resolves this text to a " +
					"calendar date. Scale-app screens usually print this SOMEWHERE near the " +
					"headline weight or measurement list — not only as a dedicated date " +
					"label, but also as a timestamp, a day/date line under a metric name, or " +
					"a history-chart axis entry for the displayed reading; check all of those " +
					"before concluding no date is shown. Use null ONLY if no date for this " +
					"reading appears anywhere on screen.",
			},
		},
		"required": []string{
			"weight_kg", "body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
			"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct", "protein_pct",
			"bone_mass_kg", "scale_bmr_kcal", "reading_date_text",
		},
		"additionalProperties": false,
	}
}

// IdentifyBodyComposition reads a smart-scale result screenshot using the
// configured model's vision input, mirroring IdentifyPhoto's shape exactly.
// There is no envelope to unwrap here (contrast unwrapGuesses/
// unwrapIngredients): bodyCompositionJSONSchema's root IS the reading
// object, so the raw response bytes go straight to
// parseBodyCompositionReading — the same helper Gemini's implementation
// uses (defined in gemini.go, same package), since a plain
// json.Unmarshal into ai.BodyCompositionReading's pointer fields is
// provider-agnostic: encoding/json sets a *float64/*string field to nil for
// a JSON null exactly as it does for a missing key, so this decodes
// correctly whether the field was omitted (Gemini, non-strict schemas) or
// explicitly null (this schema, under strict:true).
func (p OpenAIProvider) IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (ai.BodyCompositionReading, ai.Usage, error) {
	dataURL := fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(image))
	data, usage, err := p.generateJSON(ctx, p.model, callTypeIdentifyBodyComposition,
		bodyCompositionSystemPrompt,
		[]openai.ChatCompletionContentPartUnionParam{
			openai.ImageContentPart(openai.ChatCompletionContentPartImageImageURLParam{URL: dataURL}),
		},
		"body_composition_reading", bodyCompositionJSONSchema(), param.Opt[float64]{})
	if err != nil {
		return ai.BodyCompositionReading{}, usage, err
	}
	reading, err := parseBodyCompositionReading(data)
	if err != nil {
		return ai.BodyCompositionReading{}, usage, fmt.Errorf("openai: identify body composition: parse response: %w", err)
	}
	return reading, usage, nil
}

// Decompose breaks a dish into its ingredients using the configured model.
func (p OpenAIProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	prompt := fmt.Sprintf(decomposeSystemPromptTmpl, dish)
	data, usage, err := p.generateJSON(ctx, p.model, callTypeDecompose,
		prompt, []openai.ChatCompletionContentPartUnionParam{openai.TextContentPart(dish)},
		"dish_ingredients", ingredientJSONSchema(), param.Opt[float64]{})
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

// Transcribe is intentionally NOT implemented for the OpenAI-compatible
// fallback: NVIDIA's llama models are text-only, and transcription stays on
// Gemini (multimodal). Returning an error keeps the router from ever sending
// audio to a model that cannot process it.
func (p OpenAIProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return "", ai.Usage{}, fmt.Errorf("openai: transcribe: not supported — transcription stays on Gemini (multimodal audio)")
}

// GenerateText produces a free-form text response (no response_format
// schema) using the configured model, for conversational/coaching use cases.
func (p OpenAIProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	start := time.Now()

	params := openai.ChatCompletionNewParams{
		Model: p.model,
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(systemPrompt),
			openai.UserMessage(userPrompt),
		},
	}

	resp, err := p.client.Chat.Completions.New(ctx, params, p.requestOptions(ctx)...)

	usage := ai.Usage{
		Provider:  p.Name(),
		Model:     p.model,
		CallType:  callTypeCoach,
		LatencyMs: int(time.Since(start).Milliseconds()),
	}
	if resp != nil {
		usage.TokensIn = int(resp.Usage.PromptTokens)
		usage.TokensOut = int(resp.Usage.CompletionTokens)
	}
	if err != nil {
		return "", usage, fmt.Errorf("openai: chat completion: %w", err)
	}
	if len(resp.Choices) == 0 {
		return "", usage, fmt.Errorf("openai: chat completion: no choices in response")
	}

	return resp.Choices[0].Message.Content, usage, nil
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
// temperature is per-call and zero-value (param.Opt[float64]{}, meaning
// "omit — use the API's own default sampling") for every caller, including
// IdentifyBodyComposition — kora#314's under-reads were never a sampling
// problem (see bodyCompositionJSONSchema's required+nullable shape, and
// gemini.go's IdentifyBodyComposition doc comment for the measurement that
// ruled temperature out), so there is no special case to carry here.
func (p OpenAIProvider) buildParams(
	model, systemPrompt string,
	userParts []openai.ChatCompletionContentPartUnionParam,
	schemaName string,
	schema map[string]any,
	temperature param.Opt[float64],
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
		Temperature:    temperature,
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
	temperature param.Opt[float64],
) ([]byte, ai.Usage, error) {
	start := time.Now()

	params := p.buildParams(model, systemPrompt, userParts, schemaName, schema, temperature)

	resp, err := p.client.Chat.Completions.New(ctx, params, p.requestOptions(ctx)...)

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

func (p OpenAIProvider) requestOptions(ctx context.Context) []option.RequestOption {
	if p.options == nil {
		return nil
	}
	return p.options(ctx)
}

// Compile-time assertion that OpenAIProvider satisfies ai.Provider.
var _ ai.Provider = OpenAIProvider{}
