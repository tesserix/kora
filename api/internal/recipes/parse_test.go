package recipes

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// stubProvider implements ai.Provider. Only the three methods the parser uses
// are meaningful; the rest exist to satisfy the interface.
type stubProvider struct {
	name           string
	generated      string
	generateErr    error
	generateUsage  ai.Usage
	guesses        []ai.Guess
	photoErr       error
	photoUsage     ai.Usage
	ingredients    []ai.IngredientGuess
	decomposeErr   error
	decomposeUsage ai.Usage
}

func (s *stubProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return s.guesses, s.photoUsage, s.photoErr
}
func (s *stubProvider) IdentifyBodyComposition(context.Context, []byte, string) (ai.BodyCompositionReading, ai.Usage, error) {
	return ai.BodyCompositionReading{}, ai.Usage{}, nil
}
func (s *stubProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return s.ingredients, s.decomposeUsage, s.decomposeErr
}
func (s *stubProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (s *stubProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return s.generated, s.generateUsage, s.generateErr
}
func (s *stubProvider) Name() string {
	if s.name != "" {
		return s.name
	}
	return "stub"
}

// stubMeter implements ai.Meter. It records what was metered and can refuse
// budget, so the gate and the ledger are both assertable without a DB.
type stubMeter struct {
	overBudget  bool
	budgetErr   error
	recorded    []ai.Usage
	budgetCalls int
}

func (m *stubMeter) WithinBudget(context.Context, uuid.UUID) (bool, error) {
	m.budgetCalls++
	if m.budgetErr != nil {
		return false, m.budgetErr
	}
	return !m.overBudget, nil
}

func (m *stubMeter) Record(_ context.Context, _ uuid.UUID, u ai.Usage, _ float64) error {
	m.recorded = append(m.recorded, u)
	return nil
}

func (m *stubMeter) callTypes() []string {
	out := make([]string, 0, len(m.recorded))
	for _, u := range m.recorded {
		out = append(out, u.CallType)
	}
	return out
}

// TestParseTextIsMetered is the #81 lesson applied to the newest AI endpoint:
// a provider call that is not recorded is invisible to COGS, to the global cap
// that protects every other AI feature, and to the metrics that would show the
// path is broken at all.
func TestParseTextIsMetered(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	meter := &stubMeter{}
	p := NewParser(&stubProvider{
		generated: `{"name":"X","servings":1,"ingredients":[{"text":"` + f.Name + `","amount":100,"unit":"g"}]}`,
	}, nutrition.NewRepository(db), meter)

	_, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)

	require.Equal(t, 1, meter.budgetCalls, "the budget must be checked BEFORE the provider is called")
	require.Equal(t, []string{callTypeParseText}, meter.callTypes())
	require.Equal(t, ai.OutcomeOK, meter.recorded[0].Outcome)
	require.NotEmpty(t, meter.recorded[0].Provider)
}

// A failed call is billed upstream exactly like a successful one, so it must
// be recorded too — otherwise a never-working parse path and a never-attempted
// one are indistinguishable (#81).
func TestParseTextMetersFailures(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := &stubMeter{}
	p := NewParser(&stubProvider{generateErr: errors.New("upstream 503")}, nutrition.NewRepository(db), meter)

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
	require.Equal(t, []string{callTypeParseText}, meter.callTypes())
	require.Equal(t, ai.OutcomeError, meter.recorded[0].Outcome)
}

func TestParseTextMetersAbandonedPrimaryAndSuccessfulFallback(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	meter := &stubMeter{}
	provider := &ai.Router{
		Primary: &stubProvider{
			name:          "primary",
			generateErr:   errors.New("primary boom"),
			generateUsage: ai.Usage{Provider: "primary", TokensIn: 8},
		},
		Fallback: &stubProvider{
			name:          "fallback",
			generated:     `{"name":"X","servings":1,"ingredients":[{"text":"` + f.Name + `","amount":100,"unit":"g"}]}`,
			generateUsage: ai.Usage{Provider: "fallback", TokensIn: 13},
		},
	}
	p := NewParser(provider, nutrition.NewRepository(db), meter)

	_, err := p.ParseText(context.Background(), userID, "recipe")

	require.NoError(t, err)
	require.Len(t, meter.recorded, 2, "recipe generation must meter both routed provider legs")
	require.Equal(t, "primary", meter.recorded[0].Provider)
	require.Equal(t, ai.OutcomeError, meter.recorded[0].Outcome)
	require.Equal(t, callTypeParseText, meter.recorded[0].CallType)
	require.Equal(t, "fallback", meter.recorded[1].Provider)
	require.Equal(t, ai.OutcomeOK, meter.recorded[1].Outcome)
}

// A provider timeout is metered as a timeout, not a generic error, so a
// latency budget that is too tight stays visible in the ledger (spec).
func TestParseTextMetersTimeoutAsTimeout(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := &stubMeter{}
	p := NewParser(&stubProvider{generateErr: context.DeadlineExceeded}, nutrition.NewRepository(db), meter)

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
	require.Equal(t, ai.OutcomeTimeout, meter.recorded[0].Outcome)
}

// Over budget must stop the parse BEFORE any provider call: the caps exist to
// prevent spend, so reporting them after paying for the call is no cap at all.
func TestParseTextIsBudgetGated(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	provider := &stubProvider{generated: `{"name":"X","servings":1,"ingredients":[{"text":"x","amount":1,"unit":"g"}]}`}
	meter := &stubMeter{overBudget: true}
	p := NewParser(provider, nutrition.NewRepository(db), meter)

	_, err := p.ParseText(context.Background(), userID, "some recipe")
	require.ErrorIs(t, err, ErrBudgetExhausted)
	require.Empty(t, meter.recorded, "nothing was called, so nothing may be billed")
	require.NotErrorIs(t, err, ErrParseFailed, "out of budget is not a parse failure — retrying will not help")
}

// Both provider calls on the photo path are metered, not just the first.
func TestParsePhotoMetersBothProviderCalls(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	meter := &stubMeter{}
	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "dal", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "100 g"}},
	}, nutrition.NewRepository(db), meter)

	_, err := p.ParsePhoto(context.Background(), userID, []byte("jpeg"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, []string{callTypeParsePhoto, callTypeParsePhoto}, meter.callTypes(),
		"identify and decompose are two billed calls and both belong in the ledger")
}

func TestParsePhotoMetersAbandonedDecomposePrimaryAndFallback(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	meter := &stubMeter{}
	provider := &ai.Router{
		Primary: &stubProvider{
			name:           "primary",
			guesses:        []ai.Guess{{Food: "dal", Confidence: 0.9}},
			photoUsage:     ai.Usage{Provider: "primary", TokensIn: 5},
			decomposeErr:   errors.New("primary decompose boom"),
			decomposeUsage: ai.Usage{Provider: "primary", TokensIn: 7},
		},
		Fallback: &stubProvider{
			name:           "fallback",
			ingredients:    []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "100 g"}},
			decomposeUsage: ai.Usage{Provider: "fallback", TokensIn: 11},
		},
	}
	p := NewParser(provider, nutrition.NewRepository(db), meter)

	_, err := p.ParsePhoto(context.Background(), userID, []byte("jpeg"), "image/jpeg")

	require.NoError(t, err)
	require.Len(t, meter.recorded, 3, "identify plus both decompose legs are three billed calls")
	require.Equal(t, []string{callTypeParsePhoto, callTypeParsePhoto, callTypeParsePhoto}, meter.callTypes())
	require.Equal(t, ai.OutcomeError, meter.recorded[1].Outcome)
	require.Equal(t, "fallback", meter.recorded[2].Provider)
}

func TestParsePhotoIsBudgetGated(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := &stubMeter{overBudget: true}
	p := NewParser(&stubProvider{guesses: []ai.Guess{{Food: "dal"}}}, nutrition.NewRepository(db), meter)

	_, err := p.ParsePhoto(context.Background(), userID, []byte("jpeg"), "image/jpeg")
	require.ErrorIs(t, err, ErrBudgetExhausted)
	require.Empty(t, meter.recorded)
}

func TestParseTextExtractsNameServingsAndIngredients(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{generated: `{
		"name": "Masoor Dal",
		"servings": 4,
		"ingredients": [
			{"text": "` + f.Name + `", "amount": 200, "unit": "g"},
			{"text": "zqxunmatchable spice", "amount": 1, "unit": "pinch"}
		]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…pasted recipe…")
	require.NoError(t, err)
	require.Equal(t, "Masoor Dal", d.Name)
	require.Equal(t, 4, d.Servings)
	require.Equal(t, SourcePaste, d.Source)
	require.Len(t, d.Ingredients, 2)
	require.NotNil(t, d.Ingredients[0].FoodItemID, "a seeded food must resolve")
	require.Equal(t, f.ID.String(), *d.Ingredients[0].FoodItemID)
	// The unmatchable ingredient must be a NONSENSE token, not a real food.
	// This assertion originally used "asafoetida", which stopped being
	// unmatchable the moment IFCT was ingested (kora#215 added an `Asafoetida`
	// row) — so the test failed against a fully-ingested index while still
	// passing in CI, whose database holds only the curated seed. The `zqx`
	// prefix is the convention already used elsewhere for strings that must
	// never match a real row.
	require.Nil(t, d.Ingredients[1].FoodItemID, "an unmatchable ingredient stays unresolved, not guessed")
	require.Equal(t, "zqxunmatchable spice", d.Ingredients[1].RawText)
}

// TestParseTextRejectsNonJSON: GenerateText enforces no schema, so garbage is
// a parse failure the caller turns into "enter it manually" — never a
// half-built recipe.
func TestParseTextRejectsNonJSON(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generated: "Sure! Here is a lovely dal recipe…"}, nutrition.NewRepository(db), &stubMeter{})

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextProviderErrorIsParseFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generateErr: errors.New("upstream 503")}, nutrition.NewRepository(db), &stubMeter{})

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextRejectsEmptyInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{}, nutrition.NewRepository(db), &stubMeter{})

	_, err := p.ParseText(context.Background(), userID, "   ")
	require.Error(t, err)
}

// TestParseTextDiscardsModelSuppliedMacros: nutrition comes only from food
// rows. A model that volunteers kcal must not influence anything.
func TestParseTextDiscardsModelSuppliedMacros(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{
		"name": "Dal", "servings": 1,
		"ingredients": [{"text": "` + f.Name + `", "amount": 200, "unit": "g", "kcal": 9999}]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)
	require.Len(t, d.Ingredients, 1)
	require.Equal(t, 200.0, d.Ingredients[0].Grams, "grams come from the portion, not the model's kcal")
}

// TestParseSetsMatchedFoodNameOnResolvedIngredient: the review sheet needs
// the matched food's own canonical name to show what a resolved ingredient
// actually matched — not just echo back the phrase it was searched for. An
// alias is used (rather than passing the food's own name as the phrase, the
// way the other tests here do) so the phrase and the matched food's Name are
// GENUINELY different strings, proving Name came from the food row and not
// merely from copying the search phrase back.
func TestParseSetsMatchedFoodNameOnResolvedIngredient(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	foods := nutrition.NewRepository(db)
	f := seedFood(t, db, 100)
	phrase := "rc-alias-" + uuid.NewString()
	require.NoError(t, foods.AddAlias(context.Background(), userID, phrase, f.ID))

	p := NewParser(&stubProvider{generated: `{
		"name": "Test Bowl",
		"servings": 1,
		"ingredients": [
			{"text": "` + phrase + `", "amount": 100, "unit": "g"},
			{"text": "an unmatchable ingredient", "amount": 1, "unit": "pinch"}
		]
	}`}, foods, &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…pasted recipe…")
	require.NoError(t, err)
	require.Len(t, d.Ingredients, 2)

	require.NotNil(t, d.Ingredients[0].FoodItemID)
	require.Equal(t, f.Name, d.Ingredients[0].Name, "the resolved ingredient's Name is the matched food's canonical name")
	require.NotEqual(t, d.Ingredients[0].RawText, d.Ingredients[0].Name, "RawText (what was searched) and Name (what matched) must be visibly distinct")

	require.Nil(t, d.Ingredients[1].FoodItemID)
	require.Empty(t, d.Ingredients[1].Name, "an unresolved ingredient carries no matched name")
}

func TestParsePhotoDefaultsServingsAndNamesFromGuess(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "vegetable curry", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "150g", Confidence: 0.8}},
	}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParsePhoto(context.Background(), userID, []byte("jpegbytes"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "vegetable curry", d.Name)
	require.Equal(t, 1, d.Servings, "a photo cannot reveal a yield — default to 1 and let the user fix it")
	require.Equal(t, SourcePhoto, d.Source)
	require.Len(t, d.Ingredients, 1)
	require.NotNil(t, d.Ingredients[0].FoodItemID)
}

func TestParsePhotoNoGuessesIsParseFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{guesses: nil}, nutrition.NewRepository(db), &stubMeter{})

	_, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.ErrorIs(t, err, ErrParseFailed)
}

// TestParseMarksPortionAssumedWhenNoPortionPhrase: an ingredient with no
// portion phrase gets a system estimate that MUST arrive labelled (#138).
func TestParseMarksPortionAssumedWhenNoPortionPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{
		guesses:     []ai.Guess{{Food: "stew", Confidence: 0.9}},
		ingredients: []ai.IngredientGuess{{Ingredient: f.Name, PortionEstimate: "", Confidence: 0.8}},
	}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.NoError(t, err)
	require.True(t, d.Ingredients[0].PortionAssumed)
	require.Greater(t, d.Ingredients[0].Grams, 0.0)
}

// TestParseSingularisesPluralUnitAgainstServingUnit is the regression guard
// for the live-smoke defect: a Gemini extraction of "2 cloves garlic" was
// silently understated 2x because the food's serving unit is singular
// ("clove") while the model's stated unit is plural ("cloves"), and exact
// matching let the stated quantity fall through to a one-serving guess. The
// fix lives in units.ParsePhrase; this test proves it end-to-end through the
// parser, which a units-level test alone would not catch.
func TestParseSingularisesPluralUnitAgainstServingUnit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)

	garlic := nutrition.FoodItem{
		Name: "RC Garlic " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"clove","amount":1,"base_amount":3}]`),
		KcalPer100g:  100,
	}
	garlic.NormalizedName = nutrition.Normalize(garlic.Name)
	require.NoError(t, db.Create(&garlic).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", garlic.ID) })

	p := NewParser(&stubProvider{generated: `{
		"name": "Test",
		"servings": 1,
		"ingredients": [
			{"text": "` + garlic.Name + `", "amount": 2, "unit": "cloves"}
		]
	}`}, nutrition.NewRepository(db), &stubMeter{})

	d, err := p.ParseText(context.Background(), userID, "…pasted recipe…")
	require.NoError(t, err)
	require.Len(t, d.Ingredients, 1)
	require.Equal(t, 6.0, d.Ingredients[0].Grams, "2 cloves against a 3g clove serving must resolve to 6g, not a 3g one-serving guess")
	require.False(t, d.Ingredients[0].PortionAssumed, "a stated quantity that resolved against a real serving unit must never be reported as a guess")
}

func TestDraftIsNeverPersisted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{"name":"X","servings":1,"ingredients":[{"text":"` + f.Name + `","amount":100,"unit":"g"}]}`},
		nutrition.NewRepository(db), &stubMeter{})

	_, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)

	var n int64
	require.NoError(t, db.Model(&Recipe{}).Where("user_id = ?", userID).Count(&n).Error)
	require.Zero(t, n, "parse must persist nothing")
	_ = uuid.Nil
}
