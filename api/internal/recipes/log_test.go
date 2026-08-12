package recipes

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func loggingService(t *testing.T) (*Service, uuid.UUID, nutrition.FoodItem) {
	t.Helper()
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	logRepo := foodlog.NewRepository(db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).
		WithBatchLogger(foodlog.NewService(logRepo, nutrition.NewRepository(db)))
	t.Cleanup(func() {
		db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID)
		db.Exec("DELETE FROM recipes WHERE user_id = ?", userID)
	})
	return svc, userID, f
}

// TestLogRecipeScalesGramsByServingsRatio is the core arithmetic:
// log_grams = ingredient.grams × (requested / yielded).
func TestLogRecipeScalesGramsByServingsRatio(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 4, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 400, "400g lentils")},
	})
	require.NoError(t, err)

	res, err := svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 2, MealSlot: "dinner",
	})
	require.NoError(t, err)
	require.Equal(t, 1, res.Logged)
	require.Empty(t, res.Skipped)
	// 400g yields 4 servings; 2 servings is 200g.
	require.Equal(t, 200.0, lastLoggedGrams(t, svc, userID))
}

// TestLogRecipeSkipsUnresolvedAndReportsThem: an unresolved ingredient cannot
// be logged, and the user must be told rather than silently short-changed.
func TestLogRecipeSkipsUnresolvedAndReportsThem(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Curry", Servings: 1, Source: SourcePaste,
		Ingredients: []IngredientInput{
			ing(f.ID.String(), 100, "100g lentils"),
			{FoodItemID: nil, RawText: "a pinch of asafoetida"},
		},
	})
	require.NoError(t, err)

	res, err := svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.NoError(t, err)
	require.Equal(t, 1, res.Logged)
	require.Equal(t, []string{"a pinch of asafoetida"}, res.Skipped)
}

func TestLogRecipeValidates(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 2, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")},
	})
	require.NoError(t, err)
	id := uuid.MustParse(created.ID)

	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 0, MealSlot: "dinner"})
	require.Error(t, err)
	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 1, MealSlot: "brunch"})
	require.Error(t, err)
}

func TestLogRecipeRejectsAnotherUsersRecipe(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()
	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Dal", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "a")},
	})
	require.NoError(t, err)

	_, err = svc.LogRecipe(ctx, uuid.New(), uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.Error(t, err)
}

// TestLogRecipeAllUnresolvedIsAValidationError: nothing loggable must be a
// clear message, not a silent zero-row success.
func TestLogRecipeAllUnresolvedIsAValidationError(t *testing.T) {
	svc, userID, _ := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Vibes", Servings: 1, Source: SourcePaste,
		Ingredients: []IngredientInput{{FoodItemID: nil, RawText: "a pinch of asafoetida"}},
	})
	require.NoError(t, err)

	_, err = svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	})
	require.Error(t, err)
}

// lastLoggedGrams reads back the single log the test just created.
func lastLoggedGrams(t *testing.T, svc *Service, userID uuid.UUID) float64 {
	t.Helper()
	db := testDB(t)
	var grams float64
	require.NoError(t, db.Raw(
		"SELECT quantity_grams FROM food_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		userID).Scan(&grams).Error)
	return grams
}
