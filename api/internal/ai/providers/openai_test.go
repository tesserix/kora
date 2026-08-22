package providers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openai/openai-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

// Compile-time assertion that OpenAIProvider satisfies ai.Provider — if the
// SDK's shape ever forces a signature drift, this fails to compile.
var _ ai.Provider = OpenAIProvider{}

func TestNewOpenAIProvider_Name(t *testing.T) {
	p := NewOpenAIProvider("test-key", "", "", false)
	assert.Equal(t, "openai", p.Name())
}

func TestGuessJSONSchema_NoNutritionFields(t *testing.T) {
	schema := guessJSONSchema()

	require.Equal(t, "object", schema["type"])
	require.Equal(t, []string{"guesses"}, schema["required"])
	require.Equal(t, false, schema["additionalProperties"])

	props, ok := schema["properties"].(map[string]any)
	require.True(t, ok)
	guessesProp, ok := props["guesses"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "array", guessesProp["type"])

	items, ok := guessesProp["items"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "object", items["type"])
	require.Equal(t, false, items["additionalProperties"])

	itemProps, ok := items["properties"].(map[string]any)
	require.True(t, ok)

	gotProps := make([]string, 0, len(itemProps))
	for name := range itemProps {
		gotProps = append(gotProps, name)
	}

	// The exact property set is identity + portion + confidence ONLY. Any
	// nutrition-number field (kcal, protein, carbs, fat, ...) here would let
	// a hallucinated number flow straight into a Guess — this assertion is
	// the schema-boundary guard against that.
	// brand and qualifiers (kora#212 Phase 3) are identity fields — they say
	// WHICH food this is, never how much energy it has — so they widen what
	// the model may describe without widening what it may assert.
	wantProps := []string{"food", "brand", "qualifiers", "portion_estimate", "cooking_method", "confidence"}
	assert.ElementsMatch(t, wantProps, gotProps)
	// Under strict:true every property must also be listed as required, so
	// these two assertions must not be allowed to drift apart.
	assert.ElementsMatch(t, wantProps, items["required"])

	for _, forbidden := range []string{"kcal", "calories", "protein", "carbs", "fat"} {
		_, present := itemProps[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}

func TestIngredientJSONSchema_NoNutritionFields(t *testing.T) {
	schema := ingredientJSONSchema()

	require.Equal(t, "object", schema["type"])
	require.Equal(t, []string{"ingredients"}, schema["required"])

	props, ok := schema["properties"].(map[string]any)
	require.True(t, ok)
	ingredientsProp, ok := props["ingredients"].(map[string]any)
	require.True(t, ok)

	items, ok := ingredientsProp["items"].(map[string]any)
	require.True(t, ok)
	itemProps, ok := items["properties"].(map[string]any)
	require.True(t, ok)

	gotProps := make([]string, 0, len(itemProps))
	for name := range itemProps {
		gotProps = append(gotProps, name)
	}

	assert.ElementsMatch(t, []string{"ingredient", "portion_estimate", "confidence"}, gotProps)

	for _, forbidden := range []string{"kcal", "calories", "protein", "carbs", "fat"} {
		_, present := itemProps[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}

// Both schemas must marshal cleanly to valid JSON — a Structured Outputs
// request would be rejected at the API boundary otherwise, and this catches
// any unmarshalable value (e.g. an accidental function or channel field)
// well before a live call.
func TestGuessJSONSchema_MarshalsToValidJSON(t *testing.T) {
	data, err := json.Marshal(guessJSONSchema())
	require.NoError(t, err)
	var round map[string]any
	require.NoError(t, json.Unmarshal(data, &round))
}

func TestIngredientJSONSchema_MarshalsToValidJSON(t *testing.T) {
	data, err := json.Marshal(ingredientJSONSchema())
	require.NoError(t, err)
	var round map[string]any
	require.NoError(t, json.Unmarshal(data, &round))
}

func TestUnwrapGuesses_Valid(t *testing.T) {
	data := []byte(`{"guesses": [
		{"food": "grilled chicken breast", "portion_estimate": "150g", "cooking_method": "grilled", "confidence": 0.92}
	]}`)

	arr, err := unwrapGuesses(data)
	require.NoError(t, err)

	guesses, err := parseGuesses(arr)
	require.NoError(t, err)
	require.Len(t, guesses, 1)
	assert.Equal(t, ai.Guess{
		Food:            "grilled chicken breast",
		PortionEstimate: "150g",
		CookingMethod:   "grilled",
		Confidence:      0.92,
	}, guesses[0])
}

func TestUnwrapGuesses_IgnoresInjectedNutritionFields(t *testing.T) {
	// Even if a model hallucinated a kcal number into its JSON output, the
	// Guess struct has no such field to decode into — the invariant holds at
	// the parse boundary too, not just at the schema boundary.
	data := []byte(`{"guesses": [
		{"food": "pizza slice", "portion_estimate": "1 slice", "cooking_method": "baked", "confidence": 0.7, "kcal": 285, "protein": 12}
	]}`)

	arr, err := unwrapGuesses(data)
	require.NoError(t, err)

	guesses, err := parseGuesses(arr)
	require.NoError(t, err)
	require.Len(t, guesses, 1)
	assert.Equal(t, ai.Guess{
		Food:            "pizza slice",
		PortionEstimate: "1 slice",
		CookingMethod:   "baked",
		Confidence:      0.7,
	}, guesses[0])
}

func TestUnwrapGuesses_Malformed(t *testing.T) {
	_, err := unwrapGuesses([]byte(`not json`))
	require.Error(t, err)
}

func TestUnwrapGuesses_Empty(t *testing.T) {
	arr, err := unwrapGuesses([]byte(`{"guesses": []}`))
	require.NoError(t, err)

	guesses, err := parseGuesses(arr)
	require.NoError(t, err)
	assert.Empty(t, guesses)
}

func TestUnwrapIngredients_Valid(t *testing.T) {
	data := []byte(`{"ingredients": [
		{"ingredient": "flour", "portion_estimate": "200g", "confidence": 0.8},
		{"ingredient": "sugar", "portion_estimate": "50g", "confidence": 0.75}
	]}`)

	arr, err := unwrapIngredients(data)
	require.NoError(t, err)

	ingredients, err := parseIngredients(arr)
	require.NoError(t, err)
	require.Len(t, ingredients, 2)
	assert.Equal(t, ai.IngredientGuess{
		Ingredient:      "flour",
		PortionEstimate: "200g",
		Confidence:      0.8,
	}, ingredients[0])
	assert.Equal(t, ai.IngredientGuess{
		Ingredient:      "sugar",
		PortionEstimate: "50g",
		Confidence:      0.75,
	}, ingredients[1])
}

func TestUnwrapIngredients_Malformed(t *testing.T) {
	_, err := unwrapIngredients([]byte(`not json`))
	require.Error(t, err)
}

// systemTextOf reads back the plain-string content of the first system
// message in params.Messages, failing the test if none is found or the
// content isn't a plain string.
func systemTextOf(t *testing.T, params openai.ChatCompletionNewParams) string {
	t.Helper()
	for _, msg := range params.Messages {
		if msg.OfSystem == nil {
			continue
		}
		content := msg.OfSystem.Content
		require.True(t, content.OfString.Valid(), "system message content is not a plain string")
		return content.OfString.Value
	}
	t.Fatal("no system message found in params.Messages")
	return ""
}

func TestBuildParamsStrictSchemaDefault(t *testing.T) {
	p := NewOpenAIProvider("k", "", "", false)
	params := p.buildParams(modelDefault(p), "sys", nil, "food_guesses", guessJSONSchema())

	assert.Equal(t, "gpt-5-mini", params.Model)
	require.NotNil(t, params.ResponseFormat.OfJSONSchema, "expected strict json_schema response format")
	assert.Nil(t, params.ResponseFormat.OfJSONObject, "strict mode must not set json_object format")
	assert.Equal(t, "sys", systemTextOf(t, params), "strict mode must not alter the system prompt")
}

func TestBuildParamsJSONObjectCompat(t *testing.T) {
	p := NewOpenAIProvider("k", "https://integrate.api.nvidia.com/v1", "meta/llama-3.3-70b-instruct", true)
	params := p.buildParams(modelDefault(p), "sys", nil, "food_guesses", guessJSONSchema())

	assert.Equal(t, "meta/llama-3.3-70b-instruct", params.Model, "expected configured model")
	require.NotNil(t, params.ResponseFormat.OfJSONObject, "expected json_object response format for compat mode")
	assert.Nil(t, params.ResponseFormat.OfJSONSchema, "compat mode must not set strict json_schema format")

	// The schema is not enforced by json_object, so its shape must be
	// described to the model in the system message.
	sys := systemTextOf(t, params)
	assert.Contains(t, sys, "sys", "compat system prompt must still include the original prompt")
	if !strings.Contains(sys, "\"guesses\"") {
		t.Fatalf("compat system prompt missing envelope shape hint: %q", sys)
	}
}

func TestOpenAITranscribeNotSupported(t *testing.T) {
	p := NewOpenAIProvider("k", "", "", false)
	_, _, err := p.Transcribe(t.Context(), []byte("x"), "audio/mp4")
	if err == nil {
		t.Fatal("expected Transcribe to return an error on the fallback provider")
	}
}

// bodyCompositionFieldNames is the exact property set bodyCompositionJSONSchema
// must expose — every field of ai.BodyCompositionReading, JSON-tag spelling.
var bodyCompositionFieldNames = []string{
	"weight_kg", "body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
	"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct", "protein_pct",
	"bone_mass_kg", "scale_bmr_kcal", "reading_date",
}

func TestBodyCompositionJSONSchema_Shape(t *testing.T) {
	schema := bodyCompositionJSONSchema()

	require.Equal(t, "object", schema["type"])
	require.Equal(t, false, schema["additionalProperties"])

	props, ok := schema["properties"].(map[string]any)
	require.True(t, ok)

	gotProps := make([]string, 0, len(props))
	for name := range props {
		gotProps = append(gotProps, name)
	}
	// Every field of ai.BodyCompositionReading must be present, and nothing
	// else — an extra property here would let a hallucinated derived value
	// (BMI, fat-free mass, ...) flow straight into the struct.
	assert.ElementsMatch(t, bodyCompositionFieldNames, gotProps)

	// strict:true requires every property in "required" even though the
	// field is logically optional — see bodyCompositionJSONSchema's doc
	// comment for why nullable-type + required is how "may be absent from
	// the screenshot" is expressed under Structured Outputs.
	assert.ElementsMatch(t, bodyCompositionFieldNames, schema["required"])

	for _, name := range bodyCompositionFieldNames {
		prop, ok := props[name].(map[string]any)
		require.Truef(t, ok, "property %q missing or not an object", name)
		if name == "reading_date" {
			assert.Equal(t, []string{"string", "null"}, prop["type"], "reading_date must be nullable string")
		} else {
			assert.Equal(t, []string{"number", "null"}, prop["type"], "%s must be nullable number", name)
		}
	}
}

func TestBodyCompositionJSONSchema_MarshalsToValidJSON(t *testing.T) {
	data, err := json.Marshal(bodyCompositionJSONSchema())
	require.NoError(t, err)
	var round map[string]any
	require.NoError(t, json.Unmarshal(data, &round))
}

// newOpenAIStubServer starts an httptest server that returns responseBody as
// the assistant message content of a single Chat Completions response,
// mirroring the stub pattern in agentgateway_test.go.
func newOpenAIStubServer(t *testing.T, responseBody string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"id":     "completion-1",
			"object": "chat.completion",
			"choices": []map[string]any{{
				"index":         0,
				"message":       map[string]any{"role": "assistant", "content": responseBody},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
		}))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestOpenAIProvider_IdentifyBodyComposition_NullFieldsDecodeToNil(t *testing.T) {
	// weight_kg and reading_date are present; every other field is
	// explicitly JSON null (as strict:true's required-but-nullable schema
	// forces the model to answer for anything unreadable) and must decode
	// to a nil pointer, not a zero value.
	server := newOpenAIStubServer(t, `{
		"weight_kg": 72.4,
		"body_fat_pct": null,
		"subcutaneous_fat_pct": null,
		"visceral_fat_rating": null,
		"skeletal_muscle_pct": null,
		"muscle_mass_kg": null,
		"body_water_pct": null,
		"protein_pct": null,
		"bone_mass_kg": null,
		"scale_bmr_kcal": null,
		"reading_date": "2026-08-20"
	}`)

	p := NewOpenAIProvider("test-key", server.URL+"/v1", "", false)
	reading, usage, err := p.IdentifyBodyComposition(t.Context(), []byte("image"), "image/png")

	require.NoError(t, err)
	require.NotNil(t, reading.WeightKg)
	assert.Equal(t, 72.4, *reading.WeightKg)
	require.NotNil(t, reading.ReadingDate)
	assert.Equal(t, "2026-08-20", *reading.ReadingDate)
	assert.Nil(t, reading.BodyFatPct)
	assert.Nil(t, reading.SubcutaneousFatPct)
	assert.Nil(t, reading.VisceralFatRating)
	assert.Nil(t, reading.SkeletalMusclePct)
	assert.Nil(t, reading.MuscleMassKg)
	assert.Nil(t, reading.BodyWaterPct)
	assert.Nil(t, reading.ProteinPct)
	assert.Nil(t, reading.BoneMassKg)
	assert.Nil(t, reading.ScaleBMRKcal)
	assert.Equal(t, "openai", usage.Provider)
}

func TestOpenAIProvider_IdentifyBodyComposition_DropsUnschemaedExtraKey(t *testing.T) {
	// Even if a model injected a hallucinated derived field (bmi, say) into
	// its JSON output, ai.BodyCompositionReading has no field to decode it
	// into — the parse-layer half of the "never a computed value"
	// invariant, proven here against OpenAI's schema the same way Task 1
	// proved it against Gemini's.
	server := newOpenAIStubServer(t, `{
		"weight_kg": 60,
		"body_fat_pct": 22.1,
		"subcutaneous_fat_pct": null,
		"visceral_fat_rating": null,
		"skeletal_muscle_pct": null,
		"muscle_mass_kg": null,
		"body_water_pct": null,
		"protein_pct": null,
		"bone_mass_kg": null,
		"scale_bmr_kcal": null,
		"reading_date": null,
		"bmi": 21.3
	}`)

	p := NewOpenAIProvider("test-key", server.URL+"/v1", "", false)
	reading, _, err := p.IdentifyBodyComposition(t.Context(), []byte("image"), "image/png")

	require.NoError(t, err)
	require.NotNil(t, reading.WeightKg)
	assert.Equal(t, 60.0, *reading.WeightKg)
	require.NotNil(t, reading.BodyFatPct)
	assert.Equal(t, 22.1, *reading.BodyFatPct)
	assert.Nil(t, reading.ReadingDate)
}

func TestOpenAIProvider_Embed_ErrorsNotGemini(t *testing.T) {
	// Embed intentionally does not call OpenAI at all: mixing embedding
	// spaces across providers would corrupt cosine search against the
	// Gemini-populated index, so the router must keep embeddings on Gemini.
	p := NewOpenAIProvider("test-key", "", "", false)

	vec, usage, err := p.Embed(t.Context(), "grilled chicken breast")

	require.Error(t, err)
	assert.Nil(t, vec)
	assert.Equal(t, ai.Usage{}, usage)
	assert.Contains(t, err.Error(), "embed")
}
