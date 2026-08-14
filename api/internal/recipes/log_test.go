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
	}, nil)
	require.NoError(t, err)
	require.Equal(t, 1, res.Logged)
	require.Empty(t, res.Skipped)
	// 400g yields 4 servings; 2 servings is 200g.
	require.Equal(t, 200.0, lastLoggedGrams(t, svc, userID))
}

// TestLogRecipePortionAssumedSurvivesIntoFoodLog is issue #138's lesson
// applied to the recipe → diary path: r.PortionAssumed must be forwarded
// onto the BatchItem, not just carried on the recipe row. Unlike the entered
// pair (which is scale-dependent and deliberately dropped, see log.go),
// portion_assumed is scale-invariant, so it must survive scaling untouched.
func TestLogRecipePortionAssumedSurvivesIntoFoodLog(t *testing.T) {
	svc, userID, f := loggingService(t)
	ctx := context.Background()

	created, err := svc.Create(ctx, userID, SaveRecipeRequest{
		Name: "Mixed Confidence", Servings: 2, Source: SourceManual,
		Ingredients: []IngredientInput{
			{FoodItemID: strPtr(f.ID.String()), Grams: 100, RawText: "guessed lentils", PortionAssumed: true},
			{FoodItemID: strPtr(f.ID.String()), Grams: 100, RawText: "weighed rice", PortionAssumed: false},
		},
	})
	require.NoError(t, err)

	res, err := svc.LogRecipe(ctx, userID, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 2, MealSlot: "dinner",
	}, nil)
	require.NoError(t, err)
	require.Equal(t, 2, res.Logged)

	flags := loggedPortionAssumedFlags(t, userID)
	require.ElementsMatch(t, []bool{true, false}, flags,
		"the assumed ingredient's flag must reach the food log, and the weighed one's false must not be flipped")
}

// strPtr is a small literal helper for constructing IngredientInput values
// that need PortionAssumed set explicitly (the shared `ing` helper always
// defaults it false).
func strPtr(s string) *string { return &s }

// loggedPortionAssumedFlags reads back portion_assumed for every log this
// user has, in insertion order.
func loggedPortionAssumedFlags(t *testing.T, userID uuid.UUID) []bool {
	t.Helper()
	db := testDB(t)
	var flags []bool
	require.NoError(t, db.Raw(
		"SELECT portion_assumed FROM food_logs WHERE user_id = ? ORDER BY created_at ASC",
		userID).Scan(&flags).Error)
	return flags
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
	}, nil)
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

	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 0, MealSlot: "dinner"}, nil)
	require.Error(t, err)
	_, err = svc.LogRecipe(ctx, userID, id, LogRecipeRequest{Servings: 1, MealSlot: "brunch"}, nil)
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

	otherUser := uuid.New()
	_, err = svc.LogRecipe(ctx, otherUser, uuid.MustParse(created.ID), LogRecipeRequest{
		Servings: 1, MealSlot: "dinner",
	}, nil)
	require.Error(t, err)
	require.Equal(t, 0, countFoodLogs(t, svc, otherUser))
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
	}, nil)
	require.Error(t, err)
	require.Equal(t, 0, countFoodLogs(t, svc, userID))
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

// countFoodLogs proves a failed LogRecipe call wrote zero rows — a future bug
// that writes partial rows AND returns an error must not pass silently.
func countFoodLogs(t *testing.T, svc *Service, userID uuid.UUID) int {
	t.Helper()
	db := testDB(t)
	var n int64
	require.NoError(t, db.Raw(
		"SELECT COUNT(*) FROM food_logs WHERE user_id = ?", userID).Scan(&n).Error)
	return int(n)
}
