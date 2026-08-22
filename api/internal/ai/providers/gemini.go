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
	callTypeIdentifyText            = "identify_text"
	callTypeIdentifyPhoto           = "identify_photo"
	callTypeIdentifyBodyComposition = "identify_body_composition"
	callTypeDecompose               = "decompose"
	callTypeEmbed                   = "embed"
	callTypeTranscribe              = "transcribe"
	callTypeCoach                   = "coach"
)

const (
	identifySystemPrompt = "You identify foods from a description or photo. " +
		"For each distinct food you see or read about, report its name, an " +
		"estimated portion (a short human phrase like \"1 cup\" or \"150g\"), " +
		"the cooking method if apparent (e.g. \"grilled\", \"raw\", \"fried\"), " +
		"and your confidence (0.0-1.0) that the identification is correct. " +
		// kora#212 Phase 3. Splitting these out is the whole point: a brand or
		// a qualifier left inside `food` is information the resolver can never
		// recover, because it searches a name column where "El Janah chicken"
		// matches nothing and "chicken" matches everything.
		"Put the food itself in \"food\" — the plain food name, WITHOUT any " +
		"brand, shop name, portion, or descriptive words. " +
		"Put any brand, restaurant or shop the user named in \"brand\" (for " +
		"example \"El Janah\", \"McDonald's\", \"Woolworths\"), and use an " +
		"empty string when they named none — never guess a brand that was not " +
		"stated. " +
		"Put words that narrow down WHICH version of the food it is in " +
		"\"qualifiers\" (for example \"charcoal\", \"wholemeal\", \"diet\", " +
		"\"skinless\"), as a list, and use an empty list when there are none. " +
		"Do not repeat the portion or the cooking method in \"qualifiers\". " +
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

// bodyCompositionSystemPrompt encodes every trap a smart-scale screenshot
// sets: unit conversion is fine but computation is not, several fields look
// interchangeable but are not, and vendor opinion (bands like "Average") must
// never be mistaken for a measurement. Do not paraphrase it away — each
// sentence here corresponds to a specific way a vision model gets this
// wrong.
const bodyCompositionSystemPrompt = "You read a smart body-composition " +
	"scale's result screen (for example Renpho, Omron, or Tanita). Your " +
	"primary job is completeness: this screen typically shows SEVERAL " +
	"distinct measurements at once (weight, body fat, visceral fat, " +
	"muscle, water, bone, BMR, and more, depending on the scale), and you " +
	"must report EVERY one of them that is legible in the image — not " +
	"just weight. Scan the whole screen field by field against the list " +
	"below before answering, and fill in every value you can actually " +
	"see, in the same pass. Under-reporting a value that IS shown is as " +
	"wrong as fabricating one that is not: both lose real information. " +
	"That said, for any field you cannot see stated on screen, OMIT it " +
	"entirely — do not guess, do not estimate, and NEVER compute a value " +
	"from other values. Do not compute BMI from weight and height. Do not " +
	"compute a fat-free or lean mass from weight and body fat percentage. " +
	"A value you calculate rather than read is worse than no value at " +
	"all — so the rule is report everything shown, never infer anything " +
	"unshown; these two rules do not conflict, because inference is not " +
	"reading. " +
	"Report weight in kilograms as weight_kg — convert from pounds if the " +
	"screen shows pounds (1 lb = 0.453592 kg); that is unit conversion of " +
	"a single displayed number, not inference of a new fact, so it is " +
	"fine. body_fat_pct is the body fat PERCENTAGE only — if the screen " +
	"also shows a fat mass in kilograms, ignore that number and report " +
	"only the percentage. visceral_fat_rating is the scale's own visceral " +
	"fat number exactly as displayed — usually a small bare number like 7, " +
	"or \"7.5 level\", or a value on a 1-59 scale. This is a VENDOR " +
	"RATING, not a percentage: report it even when the screen shows no " +
	"percent sign, and never treat it as one. skeletal_muscle_pct and " +
	"muscle_mass_kg are TWO DIFFERENT quantities, not the same number in " +
	"two units — some apps show both. Report each ONLY if its own value " +
	"is shown; never derive one from the other. bone_mass_kg is bone MASS " +
	"in kilograms as the scale reports it — this is NOT bone density, a " +
	"T-score, or a BMD number. If the screen shows only a density or " +
	"T-score, leave bone_mass_kg unset. body_water_pct and protein_pct are " +
	"percentages as shown. scale_bmr_kcal is the scale's own estimated " +
	"basal metabolic rate in kilocalories, if shown. reading_date is the " +
	"calendar date the screenshot itself displays for this reading — " +
	"scale apps almost always show one. Report it as YYYY-MM-DD. Omit it " +
	"if no date is legible on screen, and NEVER use today's date or any " +
	"date that is not actually printed on the screen. Do NOT report BMI, " +
	"fat-free mass, lean mass, fat mass in kilograms, metabolic age, or " +
	"any qualitative band or label such as \"Average\", \"Low\", \"High\", " +
	"or \"Excellent\" — these are derived or vendor opinion, not " +
	"measurements, and must never appear in your answer. Respond with " +
	"JSON only, matching the provided schema, using only the fields you " +
	"can actually read."

// GeminiProvider implements ai.Provider over the Gemini API via
// google.golang.org/genai.
type GeminiProvider struct {
	client *genai.Client
}

// NewGeminiProvider builds a GeminiProvider authenticated with apiKey against
// the Gemini API backend (not Vertex AI).
//
// Kept for local development and for cmd/embed run from a laptop, where a key
// is simpler than arranging application-default credentials. Production uses
// NewVertexProvider — see its comment for why.
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

// NewVertexProvider builds the same provider against Vertex AI, authenticated
// by the workload's own service account rather than an API key.
//
// WHY: production ran on a personal Gemini API key on the free tier, which
// caused three separate problems that all resolve here.
//
//   - **Capacity.** The free tier shares a demand pool, and a 503 "this model
//     is currently experiencing high demand" took photo logging down entirely
//     (kora#179). Vertex has project-scoped capacity.
//   - **Quota.** The free tier caps embeddings at 1,000 per project per DAY,
//     which is what stopped the OpenFoodFacts index backfill at 607 of 5,669
//     rows (kora#97). That ceiling is the limiting factor on index growth, not
//     the ingest.
//   - **Identity.** A personal key belonging to one individual underpinned
//     production, and it had to be present in the environment. Vertex uses the
//     `kora-api` Kubernetes service account via Workload Identity
//     (kora-api-prod@, granted roles/aiplatform.user), so there is no key.
//
// LOCATION is "global" deliberately. Verified against the live API on
// 2026-08-16: asia-south1 (where this cluster runs) serves gemini-3.5-flash and
// gemini-embedding-001 but returns 404 for **gemini-3.5-flash-lite**, which the
// identify path uses. us-central1 has neither 3.5 model. Only "global" serves
// all three, so pinning a region would have forced a model change; this does
// not.
func NewVertexProvider(ctx context.Context, project, location string) (GeminiProvider, error) {
	if project == "" {
		return GeminiProvider{}, fmt.Errorf("gemini: vertex: project is required")
	}
	if location == "" {
		location = "global"
	}
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		Project:  project,
		Location: location,
		Backend:  genai.BackendVertexAI,
	})
	if err != nil {
		return GeminiProvider{}, fmt.Errorf("gemini: new vertex client: %w", err)
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
				"brand":            {Type: genai.TypeString},
				"qualifiers":       {Type: genai.TypeArray, Items: &genai.Schema{Type: genai.TypeString}},
				"portion_estimate": {Type: genai.TypeString},
				"cooking_method":   {Type: genai.TypeString},
				"confidence":       {Type: genai.TypeNumber},
			},
			// brand and qualifiers are REQUIRED so the model must decide about
			// them on every guess. Making them optional invites it to omit the
			// field when unsure, which is indistinguishable from "no brand" —
			// and "no brand" is a load-bearing signal for Phase 2's
			// generic-preference policy, not an absence.
			Required: []string{"food", "brand", "qualifiers", "portion_estimate", "cooking_method", "confidence"},
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

// bodyCompositionResponseSchema builds the JSON schema for a body-composition
// read. Unlike guessResponseSchema and ingredientResponseSchema, this
// schema has NO Required list — every field must be independently
// omittable, because "not shown on this scale's screen" is the expected
// case for most fields on any given reading (a Renpho screen and a Tanita
// screen legibly show different subsets). A Required list here would force
// the model to invent a value for a field the screen never displayed,
// which is exactly the fabrication the system prompt spends most of its
// words forbidding — this is that same rule enforced at the schema layer,
// not just the prompt layer.
func bodyCompositionResponseSchema() *genai.Schema {
	return &genai.Schema{
		Type:       genai.TypeObject,
		Properties: bodyCompositionSchemaProperties(),
	}
}

// bodyCompositionSchemaProperties is bodyCompositionResponseSchema's
// property map, factored out so it is unit-testable without constructing a
// full *genai.Schema. Each Description restates that field's specific rule
// from bodyCompositionSystemPrompt directly on the property — the model
// consults the schema alongside the prompt, so the same rule stated twice,
// in two places it actually looks, is more reliable than stating it once at
// prompt length. Keep these in sync with bodyCompositionSystemPrompt's prose
// if either changes.
func bodyCompositionSchemaProperties() map[string]*genai.Schema {
	return map[string]*genai.Schema{
		"weight_kg": {
			Type: genai.TypeNumber,
			Description: "Body weight in kilograms, as displayed. Convert " +
				"from pounds if the screen shows lb (1 lb = 0.453592 kg) — " +
				"that is unit conversion of the one displayed number, not " +
				"inference.",
		},
		"body_fat_pct": {
			Type: genai.TypeNumber,
			Description: "Body fat PERCENTAGE only. If the screen also " +
				"shows a fat mass in kilograms, ignore that number — report " +
				"only the percentage here.",
		},
		"subcutaneous_fat_pct": {
			Type:        genai.TypeNumber,
			Description: "Subcutaneous fat percentage, if the screen labels one separately from body_fat_pct.",
		},
		"visceral_fat_rating": {
			Type: genai.TypeNumber,
			Description: "The scale's own visceral fat RATING exactly as " +
				"displayed — usually a small bare number like 7, or a value " +
				"on a 1-59 scale. This is a vendor rating, not a percentage: " +
				"report it even with no percent sign shown, and never treat " +
				"it as one.",
		},
		"skeletal_muscle_pct": {
			Type: genai.TypeNumber,
			Description: "Skeletal muscle PERCENTAGE. Distinct from " +
				"muscle_mass_kg — some scales show both; report each only " +
				"if its own value is on screen, never derive one from the " +
				"other.",
		},
		"muscle_mass_kg": {
			Type: genai.TypeNumber,
			Description: "Muscle mass in kilograms, ONLY if the screen " +
				"itself labels a value as muscle mass (not skeletal " +
				"muscle). A kg figure labelled skeletal muscle mass is a " +
				"different quantity and must NOT be reported here.",
		},
		"body_water_pct": {
			Type:        genai.TypeNumber,
			Description: "Body water percentage, as displayed.",
		},
		"protein_pct": {
			Type:        genai.TypeNumber,
			Description: "Protein percentage, as displayed.",
		},
		"bone_mass_kg": {
			Type: genai.TypeNumber,
			Description: "Bone MASS in kilograms as the scale reports it — " +
				"NOT bone density, a T-score, or a BMD number. If the " +
				"screen shows only a density or T-score, leave this unset.",
		},
		"scale_bmr_kcal": {
			Type:        genai.TypeNumber,
			Description: "The scale's own estimated basal metabolic rate in kilocalories, if shown.",
		},
		"reading_date": {
			Type: genai.TypeString,
			Description: "The calendar date the SCREENSHOT ITSELF displays " +
				"for this reading, as YYYY-MM-DD. Omit if no date is " +
				"legible on screen; NEVER use today's date or any date not " +
				"actually printed on the screen.",
		},
	}
}

// IdentifyText identifies foods from a free-text phrase using Flash-Lite.
func (p GeminiProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	data, usage, err := p.generateJSON(ctx, modelFlashLite, callTypeIdentifyText,
		identifySystemPrompt, []*genai.Part{genai.NewPartFromText(phrase)}, guessResponseSchema(), nil)
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
		identifySystemPrompt, []*genai.Part{genai.NewPartFromBytes(image, mime)}, guessResponseSchema(), nil)
	if err != nil {
		return nil, usage, err
	}
	guesses, err := parseGuesses(data)
	if err != nil {
		return nil, usage, fmt.Errorf("gemini: identify photo: parse response: %w", err)
	}
	return guesses, usage, nil
}

// IdentifyBodyComposition reads a smart-scale result screenshot using Flash
// (multimodal) and returns only the fields legibly shown — see
// bodyCompositionSystemPrompt and bodyCompositionResponseSchema for the two
// independent layers (prompt + schema) that together forbid a computed or
// vendor-opinion value from ever reaching ai.BodyCompositionReading.
func (p GeminiProvider) IdentifyBodyComposition(ctx context.Context, image []byte, mime string) (ai.BodyCompositionReading, ai.Usage, error) {
	temperature := bodyCompositionTemperature
	data, usage, err := p.generateJSON(ctx, modelFlash, callTypeIdentifyBodyComposition,
		bodyCompositionSystemPrompt, []*genai.Part{genai.NewPartFromBytes(image, mime)}, bodyCompositionResponseSchema(), &temperature)
	if err != nil {
		return ai.BodyCompositionReading{}, usage, err
	}
	reading, err := parseBodyCompositionReading(data)
	if err != nil {
		return ai.BodyCompositionReading{}, usage, fmt.Errorf("gemini: identify body composition: parse response: %w", err)
	}
	return reading, usage, nil
}

// Decompose breaks a dish into its ingredients using Flash-Lite.
func (p GeminiProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	prompt := fmt.Sprintf(decomposeSystemPromptTmpl, dish)
	data, usage, err := p.generateJSON(ctx, modelFlashLite, callTypeDecompose,
		prompt, []*genai.Part{genai.NewPartFromText(dish)}, ingredientResponseSchema(), nil)
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

// bodyCompositionTemperature pins IdentifyBodyComposition's sampling to
// near-deterministic. The REASONING is that this is a TRANSCRIPTION task
// (read the printed numbers off a screen), not a creative one, so the unset
// SDK default (~1.0) was HYPOTHESISED to be why kora#314 read only
// weight_kg on 5 of 6 real calls despite a prompt and schema that already
// forbid nothing else. Read that as a hypothesis, not a finding — the
// caveat below records evidence pointing the other way. generateJSON's other
// three callers (IdentifyText, IdentifyPhoto, Decompose) pass a nil
// temperature deliberately: food-phrase resolution is the app's core path,
// and tightening its sampling is a real regression risk that is explicitly
// out of scope here — see TestGenerateContentConfig_FoodPathsLeaveTemperatureUnset.
//
// UNVERIFIED CAVEAT: a small number of live calls made while building this
// fix (not a controlled measurement — daily free-tier quota ran out mid-way,
// see PR discussion) showed temperature 0 returning FEWER legible fields
// than an unset temperature on the same fixture across repeated calls, the
// opposite of what this constant assumes. That sample is too small to act
// on, but it means this value is NOT proven correct — re-run
// bodyread's smoke test (5+ consecutive clean runs per fixture, per its own
// doc comment) before treating kora#314 as closed, and be ready to try a
// low non-zero value or drop this back to nil if temperature 0 keeps
// collapsing to a near-empty answer.
const bodyCompositionTemperature float32 = 0

// buildGenerateContentConfig builds the *genai.GenerateContentConfig for a
// generateJSON call. Factored out as a pure function (no SDK/network call)
// so the temperature-threading behaviour is unit-testable directly, rather
// than only observable by making a real API call.
func buildGenerateContentConfig(systemPrompt string, schema *genai.Schema, temperature *float32) *genai.GenerateContentConfig {
	return &genai.GenerateContentConfig{
		// Built directly (not via NewContentFromParts) so Role stays empty:
		// a system instruction is not a conversation turn, so it should not
		// be tagged "user" — this matches the SDK's own examples.
		SystemInstruction: &genai.Content{Parts: []*genai.Part{genai.NewPartFromText(systemPrompt)}},
		ResponseMIMEType:  "application/json",
		ResponseSchema:    schema,
		Temperature:       temperature,
	}
}

// generateJSON is the shared SDK glue for IdentifyText/IdentifyPhoto/
// Decompose/IdentifyBodyComposition: it calls GenerateContent with a JSON
// response schema and returns the raw response text for the caller's pure
// parse helper, plus a populated Usage. The schema is the sole invariant
// boundary — no nutrition field is ever a valid property, so the model
// structurally cannot return one no matter what the prompt says.
//
// temperature is per-call and nil by default (SDK/model default sampling):
// only IdentifyBodyComposition passes a non-nil value. See
// bodyCompositionTemperature's doc comment for why this must stay per-call
// rather than becoming a field on GeminiProvider or a package default.
func (p GeminiProvider) generateJSON(
	ctx context.Context,
	model string,
	callType string,
	systemPrompt string,
	userParts []*genai.Part,
	schema *genai.Schema,
	temperature *float32,
) ([]byte, ai.Usage, error) {
	start := time.Now()

	cfg := buildGenerateContentConfig(systemPrompt, schema, temperature)

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

// parseBodyCompositionReading decodes the model's JSON object response into
// ai.BodyCompositionReading. Pure function (no SDK/network dependency) so it
// can be unit-tested directly against hand-written sample JSON — see
// parseGuesses. Every field in the target struct is a pointer, so a key
// absent from data decodes to nil rather than a zero value, and any
// unschemaed key present in data (a hallucinated "bmi", say) is silently
// dropped by encoding/json because BodyCompositionReading has no field to
// receive it — this is the parse-layer half of the "never a computed value"
// invariant; bodyCompositionResponseSchema's lack of a BMI property is the
// other half.
func parseBodyCompositionReading(data []byte) (ai.BodyCompositionReading, error) {
	var reading ai.BodyCompositionReading
	if err := json.Unmarshal(data, &reading); err != nil {
		return ai.BodyCompositionReading{}, fmt.Errorf("parse body composition reading: %w", err)
	}
	return reading, nil
}

// Compile-time assertion that GeminiProvider satisfies ai.Provider.
var _ ai.Provider = GeminiProvider{}
