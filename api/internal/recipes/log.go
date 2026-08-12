package recipes

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/httpx"
)

// logSource tags every food log a recipe produces, so recipe-driven logs are
// distinguishable from hand-entered ones.
const logSource = "recipe"

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

// maxLogServings bounds one log call. A recipe is a household-scale dish; a
// request for hundreds of servings is a client bug, not a meal.
const maxLogServings = 20.0

// BatchLogger is the narrow slice of foodlog.Service this package needs. It
// is an interface so the recipes service does not depend on the whole food-log
// surface, and so tests can drive the fan-out directly.
type BatchLogger interface {
	CreateBatch(ctx context.Context, userID uuid.UUID, req foodlog.CreateBatchRequest) ([]foodlog.FoodLog, error)
}

// WithBatchLogger attaches the log fan-out target, following the functional
// option pattern already used by foodlog.Service.WithResolutionCache — added
// this way so every existing NewService call site keeps working unchanged.
func (s *Service) WithBatchLogger(bl BatchLogger) *Service {
	s.batch = bl
	return s
}

type LogRecipeRequest struct {
	Servings float64   `json:"servings"`
	MealSlot string    `json:"meal_slot"`
	LoggedAt time.Time `json:"logged_at"`
}

// LogRecipeResult reports what actually reached the diary. Skipped names the
// unresolved ingredients that could not be logged, so the client can tell the
// user what was left out instead of quietly under-reporting the meal.
type LogRecipeResult struct {
	Logged  int      `json:"logged"`
	Skipped []string `json:"skipped"`
}

// LogRecipe fans a recipe out into one food_logs row per RESOLVED ingredient,
// grams scaled by (requested servings / recipe yield).
//
// Deliberately NOT one synthetic "recipe" row: the diary, log_corrections,
// memory and every macro computation operate on food-item rows, so a
// synthetic row would be invisible to the food index and uncorrectable.
// Saved meals already fan out this way.
func (s *Service) LogRecipe(ctx context.Context, userID, recipeID uuid.UUID, req LogRecipeRequest) (LogRecipeResult, error) {
	if s.batch == nil {
		return LogRecipeResult{}, httpx.ValidationError{Message: "logging is unavailable"}
	}
	if req.Servings <= 0 {
		return LogRecipeResult{}, httpx.ValidationError{Message: "servings must be positive"}
	}
	if req.Servings > maxLogServings {
		return LogRecipeResult{}, httpx.ValidationError{Message: "that is too many servings to log at once"}
	}
	if !validMealSlots[req.MealSlot] {
		return LogRecipeResult{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}

	rec, err := s.repo.GetForUser(ctx, userID, recipeID)
	if err != nil {
		return LogRecipeResult{}, err // gorm.ErrRecordNotFound → 404
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, []uuid.UUID{rec.ID})
	if err != nil {
		return LogRecipeResult{}, err
	}

	ratio := req.Servings / float64(rec.Servings)
	items := make([]foodlog.BatchItem, 0, len(rows))
	skipped := []string{}
	for _, r := range rows {
		if r.FoodItemID == nil {
			skipped = append(skipped, r.RawText)
			continue
		}
		grams := r.Grams * ratio
		if grams <= 0 {
			skipped = append(skipped, r.RawText)
			continue
		}
		// The entered pair is deliberately NOT forwarded: it describes ONE
		// recipe's worth ("2 sachets"), and a fractional-serving log needs
		// the scaled grams instead. Forwarding it would make the server
		// re-resolve the unscaled amount and log the wrong quantity.
		items = append(items, foodlog.BatchItem{FoodItemID: *r.FoodItemID, QuantityGrams: grams})
	}
	if len(items) == 0 {
		return LogRecipeResult{}, httpx.ValidationError{Message: "no ingredients in this recipe can be logged yet"}
	}

	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	logs, err := s.batch.CreateBatch(ctx, userID, foodlog.CreateBatchRequest{
		LoggedAt: loggedAt, MealSlot: req.MealSlot, Items: items, Source: logSource,
	})
	if err != nil {
		return LogRecipeResult{}, err
	}
	return LogRecipeResult{Logged: len(logs), Skipped: skipped}, nil
}
