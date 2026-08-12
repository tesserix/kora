package recipes

import (
	"context"
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
	generated    string
	generateErr  error
	guesses      []ai.Guess
	photoErr     error
	ingredients  []ai.IngredientGuess
	decomposeErr error
}

func (s *stubProvider) IdentifyText(context.Context, string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	return s.guesses, ai.Usage{}, s.photoErr
}
func (s *stubProvider) Decompose(context.Context, string) ([]ai.IngredientGuess, ai.Usage, error) {
	return s.ingredients, ai.Usage{}, s.decomposeErr
}
func (s *stubProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}
func (s *stubProvider) Transcribe(context.Context, []byte, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}
func (s *stubProvider) GenerateText(context.Context, string, string) (string, ai.Usage, error) {
	return s.generated, ai.Usage{}, s.generateErr
}
func (s *stubProvider) Name() string { return "stub" }

func TestParseTextExtractsNameServingsAndIngredients(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)

	p := NewParser(&stubProvider{generated: `{
		"name": "Masoor Dal",
		"servings": 4,
		"ingredients": [
			{"text": "` + f.Name + `", "amount": 200, "unit": "g"},
			{"text": "asafoetida", "amount": 1, "unit": "pinch"}
		]
	}`}, nutrition.NewRepository(db))

	d, err := p.ParseText(context.Background(), userID, "…pasted recipe…")
	require.NoError(t, err)
	require.Equal(t, "Masoor Dal", d.Name)
	require.Equal(t, 4, d.Servings)
	require.Equal(t, SourcePaste, d.Source)
	require.Len(t, d.Ingredients, 2)
	require.NotNil(t, d.Ingredients[0].FoodItemID, "a seeded food must resolve")
	require.Equal(t, f.ID.String(), *d.Ingredients[0].FoodItemID)
	require.Nil(t, d.Ingredients[1].FoodItemID, "an unmatchable ingredient stays unresolved, not guessed")
	require.Equal(t, "asafoetida", d.Ingredients[1].RawText)
}

// TestParseTextRejectsNonJSON: GenerateText enforces no schema, so garbage is
// a parse failure the caller turns into "enter it manually" — never a
// half-built recipe.
func TestParseTextRejectsNonJSON(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generated: "Sure! Here is a lovely dal recipe…"}, nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextProviderErrorIsParseFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{generateErr: errors.New("upstream 503")}, nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.ErrorIs(t, err, ErrParseFailed)
}

func TestParseTextRejectsEmptyInput(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	p := NewParser(&stubProvider{}, nutrition.NewRepository(db))

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
	}`}, nutrition.NewRepository(db))

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
	}`}, foods)

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
	}, nutrition.NewRepository(db))

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
	p := NewParser(&stubProvider{guesses: nil}, nutrition.NewRepository(db))

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
	}, nutrition.NewRepository(db))

	d, err := p.ParsePhoto(context.Background(), userID, []byte("x"), "image/jpeg")
	require.NoError(t, err)
	require.True(t, d.Ingredients[0].PortionAssumed)
	require.Greater(t, d.Ingredients[0].Grams, 0.0)
}

func TestDraftIsNeverPersisted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	p := NewParser(&stubProvider{generated: `{"name":"X","servings":1,"ingredients":[{"text":"` + f.Name + `","amount":100,"unit":"g"}]}`},
		nutrition.NewRepository(db))

	_, err := p.ParseText(context.Background(), userID, "…")
	require.NoError(t, err)

	var n int64
	require.NoError(t, db.Model(&Recipe{}).Where("user_id = ?", userID).Count(&n).Error)
	require.Zero(t, n, "parse must persist nothing")
	_ = uuid.Nil
}
