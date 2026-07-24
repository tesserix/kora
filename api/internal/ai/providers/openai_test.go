package providers

import (
	"context"
	"encoding/json"
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
	assert.ElementsMatch(t, []string{"food", "portion_estimate", "cooking_method", "confidence"}, gotProps)
	assert.ElementsMatch(t, []string{"food", "portion_estimate", "cooking_method", "confidence"}, items["required"])

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
	_, _, err := p.Transcribe(context.Background(), []byte("x"), "audio/mp4")
	if err == nil {
		t.Fatal("expected Transcribe to return an error on the fallback provider")
	}
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
