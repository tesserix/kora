package providers

import (
	"strings"
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

// TestEstimateEmbedTokens_NeverZeroForNonEmptyInput pins kora#376's actual
// fix: 10,213 successful production embed calls recorded TokensIn: 0 because
// GeminiProvider.Embed never read any token count at all (there is none to
// read — see Embed's doc comment). The estimator must never repeat that for
// non-empty input, however short.
func TestEstimateEmbedTokens_NeverZeroForNonEmptyInput(t *testing.T) {
	for _, text := range []string{"a", "hi", "grilled chicken", strings.Repeat("x", 3)} {
		got := estimateEmbedTokens(text)
		assert.Greaterf(t, got, 0, "estimateEmbedTokens(%q) = 0, want > 0", text)
	}
}

func TestEstimateEmbedTokens_EmptyInputIsZero(t *testing.T) {
	assert.Equal(t, 0, estimateEmbedTokens(""))
}

// TestEstimateEmbedTokens_RoughlyFourPointThreeCharsPerToken pins the stated
// ratio so a future edit to the heuristic has to change this test deliberately
// rather than by accident.
//
// Updated for kora#538. The ratio was 4 chars/token with rounding UP, which
// measured +22.5% against provider-reported counts; it is now 4.3 with
// rounding to NEAREST. The 5-char case below is the one that moved, and it is
// the whole point: rounding up charged 2 tokens for every 5-character phrase,
// and Kora's embedding inputs are food phrases averaging ~12 characters, so
// that rounding alone accounted for about half the over-count.
func TestEstimateEmbedTokens_RoughlyFourPointThreeCharsPerToken(t *testing.T) {
	assert.Equal(t, 1, estimateEmbedTokens("abcd"))    // 4 chars -> 0.93 -> 1
	assert.Equal(t, 1, estimateEmbedTokens("abcde"))   // 5 chars -> 1.16 -> 1 (was 2 under ceil)
	assert.Equal(t, 2, estimateEmbedTokens("grilled")) // 7 chars -> 1.63 -> 2
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
	data := []byte(`{"weight_kg": 72.4, "body_fat_pct": 18.2, "reading_date_text": "22/08"}`)

	reading, err := parseBodyCompositionReading(data)

	require.NoError(t, err)
	assert.Equal(t, ai.BodyCompositionReading{
		WeightKg:        f64(72.4),
		BodyFatPct:      f64(18.2),
		ReadingDateText: str("22/08"),
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

// TestParseBodyCompositionReading_ReadingDateTextRoundTripsAndOmitsWhenAbsent
// pins that the provider decodes the model's raw, verbatim date text into
// ReadingDateText — NOT into the resolved ReadingDate field, which the
// provider layer never populates at all (see date_resolve.go in
// internal/bodyread for where ReadingDate actually gets set).
func TestParseBodyCompositionReading_ReadingDateTextRoundTripsAndOmitsWhenAbsent(t *testing.T) {
	withDate, err := parseBodyCompositionReading([]byte(`{"reading_date_text": "Sat, 22/08, 10:57"}`))
	require.NoError(t, err)
	require.NotNil(t, withDate.ReadingDateText)
	assert.Equal(t, "Sat, 22/08, 10:57", *withDate.ReadingDateText)
	assert.Nil(t, withDate.ReadingDate, "the provider must never populate the resolved date itself")

	withoutDate, err := parseBodyCompositionReading([]byte(`{"weight_kg": 65.0}`))
	require.NoError(t, err)
	assert.Nil(t, withoutDate.ReadingDateText)
}

func TestParseBodyCompositionReading_Malformed(t *testing.T) {
	_, err := parseBodyCompositionReading([]byte(`[1, 2, 3]`))
	require.Error(t, err)
}

// TestBodyCompositionResponseSchema_RequiredAndNullable pins kora#314's
// actual root-cause fix: every property is BOTH Required and Nullable.
// The earlier shape (nothing required, every field independently
// omittable) let a one-property response satisfy the schema, so the model
// had no obligation to report anything beyond the single field it was most
// confident about — measured against Vertex AI, that under-read to
// weight_kg-only on the large majority of real calls. Required+Nullable
// forces every key to appear (so the model must make an explicit decision
// about each field) while still letting an unreadable field decode to nil
// via JSON null, so "not shown on screen" is preserved exactly — it just
// can no longer be expressed by silent omission.
func TestBodyCompositionResponseSchema_RequiredAndNullable(t *testing.T) {
	schema := bodyCompositionResponseSchema()

	require.Equal(t, genai.TypeObject, schema.Type)

	wantFields := []string{
		"weight_kg", "body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
		"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct", "protein_pct",
		"bone_mass_kg", "scale_bmr_kcal", "reading_date_text", "instrument",
	}
	assert.ElementsMatch(t, wantFields, schema.Required,
		"every property must be Required — that is how this schema expresses optional, not by omission")

	gotProps := make([]string, 0, len(schema.Properties))
	for name, prop := range schema.Properties {
		gotProps = append(gotProps, name)
		require.NotNilf(t, prop.Nullable, "property %q must set Nullable — required-but-not-nullable would force fabrication", name)
		assert.Truef(t, *prop.Nullable, "property %q must be Nullable so an unreadable field decodes to nil, not a forced value", name)
	}
	assert.ElementsMatch(t, wantFields, gotProps)

	for _, forbidden := range []string{"bmi", "fat_free_mass", "lean_mass", "fat_mass_kg", "metabolic_age"} {
		_, present := schema.Properties[forbidden]
		assert.Falsef(t, present, "schema must not have a %q property", forbidden)
	}
}

// TestBodyCompositionResponseSchema_EveryPropertyHasDescription pins
// kora#314's second fix: bare {Type: TypeNumber} properties carried none of
// the field-specific rules the system prompt spends most of its words on.
// Restating each rule directly on the property the model consults gives it
// a second, structurally-attached place to find it.
func TestBodyCompositionResponseSchema_EveryPropertyHasDescription(t *testing.T) {
	schema := bodyCompositionResponseSchema()
	for name, prop := range schema.Properties {
		assert.NotEmptyf(t, prop.Description, "property %q has no Description", name)
	}
}

// TestBodyCompositionResponseSchema_MuscleMassDescriptionWarnsAgainstSkeletalConflation
// mirrors the OpenAI-side test of the same name: muscle_mass_kg must never
// receive a skeletal-muscle-mass figure, which is the exact trap migration
// 000039 documents.
func TestBodyCompositionResponseSchema_MuscleMassDescriptionWarnsAgainstSkeletalConflation(t *testing.T) {
	schema := bodyCompositionResponseSchema()
	desc := strings.ToLower(schema.Properties["muscle_mass_kg"].Description)
	assert.Contains(t, desc, "skeletal", "muscle_mass_kg description must warn against skeletal muscle mass conflation")
}

// TestBuildGenerateContentConfig_LeavesTemperatureUnset pins the current
// state for every generateJSON caller, including IdentifyBodyComposition:
// no caller passes a temperature override (kora#314's under-reads were
// never a sampling problem — see bodyCompositionResponseSchema's doc
// comment for the actual root cause), so the config builder must never set
// Temperature on its own.
func TestBuildGenerateContentConfig_LeavesTemperatureUnset(t *testing.T) {
	cfg := buildGenerateContentConfig(identifySystemPrompt, guessResponseSchema())
	assert.Nil(t, cfg.Temperature, "config must leave Temperature nil (SDK/model default)")

	bodyCompCfg := buildGenerateContentConfig(bodyCompositionSystemPrompt, bodyCompositionResponseSchema())
	assert.Nil(t, bodyCompCfg.Temperature, "body-composition config must leave Temperature nil too")
}
