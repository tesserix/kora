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
	//
	// brand and qualifiers (kora#212 Phase 3) are identity fields: they say
	// WHICH food this is, never how much energy it has. Adding them widens
	// what the model may describe without widening what it may assert.
	assert.ElementsMatch(t, []string{
		"food", "brand", "qualifiers", "portion_estimate", "cooking_method", "confidence",
	}, gotProps)

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

// f64 and str are local pointer-of-literal helpers for building expected
// ai.BodyCompositionReading values — every field on that struct is a
// pointer, so a plain literal cannot be assigned directly.
func f64(v float64) *float64 { return &v }
func str(v string) *string   { return &v }

func TestParseBodyCompositionReading_MissingKeysDecodeToNil(t *testing.T) {
	// Only two of ten possible numeric fields plus the date are present. The
	// point of this test is that the ABSENT fields come back nil, not 0 —
	// 0 would be indistinguishable from "the scale read exactly zero",
	// which is the whole reason every field on BodyCompositionReading is a
	// pointer.
	data := []byte(`{"weight_kg": 72.4, "body_fat_pct": 18.2, "reading_date": "2026-08-20"}`)

	reading, err := parseBodyCompositionReading(data)

	require.NoError(t, err)
	assert.Equal(t, ai.BodyCompositionReading{
		WeightKg:    f64(72.4),
		BodyFatPct:  f64(18.2),
		ReadingDate: str("2026-08-20"),
	}, reading)
	assert.Nil(t, reading.SubcutaneousFatPct)
	assert.Nil(t, reading.VisceralFatRating)
	assert.Nil(t, reading.SkeletalMusclePct)
	assert.Nil(t, reading.MuscleMassKg)
	assert.Nil(t, reading.BodyWaterPct)
	assert.Nil(t, reading.ProteinPct)
	assert.Nil(t, reading.BoneMassKg)
	assert.Nil(t, reading.ScaleBMRKcal)
}

func TestParseBodyCompositionReading_IgnoresUnschemaedKeys(t *testing.T) {
	// A model that tried to report BMI or metabolic age anyway must have
	// that value silently dropped — BodyCompositionReading has no field to
	// receive it. This is the parse-layer half of the "never a computed
	// value" invariant; bodyCompositionResponseSchema's lack of these
	// properties is the other half, and is not independently testable
	// without a live call (Task 5's smoke test covers that side).
	data := []byte(`{"weight_kg": 80.0, "bmi": 24.1, "metabolic_age": 30}`)

	reading, err := parseBodyCompositionReading(data)

	require.NoError(t, err)
	assert.Equal(t, ai.BodyCompositionReading{WeightKg: f64(80.0)}, reading)
}

func TestParseBodyCompositionReading_VisceralFatRatingIsNotPercentShaped(t *testing.T) {
	// visceral_fat_rating is a vendor RATING (e.g. 7, or 7.5), never a
	// percentage — this decodes it through the exact same float64 pointer
	// field as every other measurement, proving there is no separate
	// percent-shaped parsing path that could misinterpret a bare integer
	// like 7 as "7%".
	data := []byte(`{"visceral_fat_rating": 7}`)

	reading, err := parseBodyCompositionReading(data)

	require.NoError(t, err)
	assert.Equal(t, ai.BodyCompositionReading{VisceralFatRating: f64(7)}, reading)
}

func TestParseBodyCompositionReading_ReadingDateRoundTripsAndOmitsWhenAbsent(t *testing.T) {
	withDate, err := parseBodyCompositionReading([]byte(`{"reading_date": "2026-08-20"}`))
	require.NoError(t, err)
	require.NotNil(t, withDate.ReadingDate)
	assert.Equal(t, "2026-08-20", *withDate.ReadingDate)

	withoutDate, err := parseBodyCompositionReading([]byte(`{"weight_kg": 65.0}`))
	require.NoError(t, err)
	assert.Nil(t, withoutDate.ReadingDate)
}

func TestParseBodyCompositionReading_Malformed(t *testing.T) {
	_, err := parseBodyCompositionReading([]byte(`[1, 2, 3]`))
	require.Error(t, err)
}

func TestBodyCompositionResponseSchema_NoRequiredList(t *testing.T) {
	schema := bodyCompositionResponseSchema()

	require.Equal(t, genai.TypeObject, schema.Type)
	// Every field must be independently omittable — a Required list here
	// would force the model to invent a value the screen never displayed.
	// See bodyCompositionResponseSchema's doc comment.
	assert.Empty(t, schema.Required)

	gotProps := make([]string, 0, len(schema.Properties))
	for name := range schema.Properties {
		gotProps = append(gotProps, name)
	}
	assert.ElementsMatch(t, []string{
		"weight_kg", "body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
		"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct", "protein_pct",
		"bone_mass_kg", "scale_bmr_kcal", "reading_date",
	}, gotProps)

	for _, forbidden := range []string{"bmi", "fat_free_mass", "lean_mass", "fat_mass_kg", "metabolic_age"} {
		_, present := schema.Properties[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}
