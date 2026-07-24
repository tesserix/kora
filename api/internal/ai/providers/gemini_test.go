package providers

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/genai"

	"github.com/tesserix/kora/api/internal/ai"
)

// Compile-time assertion that GeminiProvider satisfies ai.Provider — if the
// SDK's shape ever forces a signature drift, this fails to compile.
var _ ai.Provider = GeminiProvider{}

func TestGuessResponseSchema_NoNutritionFields(t *testing.T) {
	schema := guessResponseSchema()

	require.Equal(t, genai.TypeArray, schema.Type)
	require.NotNil(t, schema.Items)
	require.Equal(t, genai.TypeObject, schema.Items.Type)

	gotProps := make([]string, 0, len(schema.Items.Properties))
	for name := range schema.Items.Properties {
		gotProps = append(gotProps, name)
	}

	// The exact property set is identity + portion + confidence ONLY. Any
	// nutrition-number field (kcal, protein, carbs, fat, ...) here would let
	// a hallucinated number flow straight into a Guess — this assertion is
	// the schema-boundary guard against that.
	assert.ElementsMatch(t, []string{"food", "portion_estimate", "cooking_method", "confidence"}, gotProps)

	for _, forbidden := range []string{"kcal", "calories", "protein", "carbs", "fat"} {
		_, present := schema.Items.Properties[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}

func TestIngredientResponseSchema_NoNutritionFields(t *testing.T) {
	schema := ingredientResponseSchema()

	require.Equal(t, genai.TypeArray, schema.Type)
	require.NotNil(t, schema.Items)
	require.Equal(t, genai.TypeObject, schema.Items.Type)

	gotProps := make([]string, 0, len(schema.Items.Properties))
	for name := range schema.Items.Properties {
		gotProps = append(gotProps, name)
	}

	assert.ElementsMatch(t, []string{"ingredient", "portion_estimate", "confidence"}, gotProps)

	for _, forbidden := range []string{"kcal", "calories", "protein", "carbs", "fat"} {
		_, present := schema.Items.Properties[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}

func TestParseGuesses_Valid(t *testing.T) {
	data := []byte(`[
		{"food": "grilled chicken breast", "portion_estimate": "150g", "cooking_method": "grilled", "confidence": 0.92},
		{"food": "white rice", "portion_estimate": "1 cup", "cooking_method": "boiled", "confidence": 0.85}
	]`)

	guesses, err := parseGuesses(data)

	require.NoError(t, err)
	require.Len(t, guesses, 2)
	assert.Equal(t, ai.Guess{
		Food:            "grilled chicken breast",
		PortionEstimate: "150g",
		CookingMethod:   "grilled",
		Confidence:      0.92,
	}, guesses[0])
	assert.Equal(t, ai.Guess{
		Food:            "white rice",
		PortionEstimate: "1 cup",
		CookingMethod:   "boiled",
		Confidence:      0.85,
	}, guesses[1])
}

func TestParseGuesses_IgnoresInjectedNutritionFields(t *testing.T) {
	// Even if a model hallucinated a kcal number into its JSON output, the
	// Guess struct has no such field to decode into — the invariant holds at
	// the parse boundary too, not just at the schema boundary.
	data := []byte(`[
		{"food": "pizza slice", "portion_estimate": "1 slice", "cooking_method": "baked", "confidence": 0.7, "kcal": 285, "protein": 12}
	]`)

	guesses, err := parseGuesses(data)

	require.NoError(t, err)
	require.Len(t, guesses, 1)
	assert.Equal(t, ai.Guess{
		Food:            "pizza slice",
		PortionEstimate: "1 slice",
		CookingMethod:   "baked",
		Confidence:      0.7,
	}, guesses[0])
}

func TestParseGuesses_Malformed(t *testing.T) {
	_, err := parseGuesses([]byte(`not json`))
	require.Error(t, err)
}

func TestParseGuesses_Empty(t *testing.T) {
	guesses, err := parseGuesses([]byte(`[]`))
	require.NoError(t, err)
	assert.Empty(t, guesses)
}

func TestParseIngredients_Valid(t *testing.T) {
	data := []byte(`[
		{"ingredient": "flour", "portion_estimate": "200g", "confidence": 0.8},
		{"ingredient": "sugar", "portion_estimate": "50g", "confidence": 0.75}
	]`)

	ingredients, err := parseIngredients(data)

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

func TestParseIngredients_IgnoresInjectedNutritionFields(t *testing.T) {
	data := []byte(`[
		{"ingredient": "butter", "portion_estimate": "20g", "confidence": 0.6, "fat": 14.7, "kcal": 130}
	]`)

	ingredients, err := parseIngredients(data)

	require.NoError(t, err)
	require.Len(t, ingredients, 1)
	assert.Equal(t, ai.IngredientGuess{
		Ingredient:      "butter",
		PortionEstimate: "20g",
		Confidence:      0.6,
	}, ingredients[0])
}

func TestParseIngredients_Malformed(t *testing.T) {
	_, err := parseIngredients([]byte(`{"not": "an array"}`))
	require.Error(t, err)
}

func TestNewGeminiProvider_Name(t *testing.T) {
	p := GeminiProvider{}
	assert.Equal(t, "gemini", p.Name())
}

func TestTranscribeCallTypeConst(t *testing.T) {
	if callTypeTranscribe != "transcribe" {
		t.Fatalf("callTypeTranscribe = %q", callTypeTranscribe)
	}
}
