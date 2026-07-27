package foodlog

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type LogRequest struct {
	FoodItemID    *uuid.UUID `json:"food_item_id"`
	Description   string     `json:"description"`
	MealSlot      string     `json:"meal_slot"`
	Source        string     `json:"source"`
	QuantityGrams float64    `json:"quantity_grams"`
	LoggedAt      time.Time  `json:"logged_at"`
	ClientLogMs   *int       `json:"client_log_ms"`
}

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

type Service struct {
	logs  Repository
	foods nutrition.Repository
}

func NewService(logs Repository, foods nutrition.Repository) Service {
	return Service{logs: logs, foods: foods}
}

func (s Service) LogFood(ctx context.Context, userID uuid.UUID, req LogRequest) (FoodLog, error) {
	if !validMealSlots[req.MealSlot] {
		return FoodLog{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	if req.QuantityGrams <= 0 {
		return FoodLog{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
	}
	if req.FoodItemID == nil {
		return FoodLog{}, httpx.ValidationError{Message: "food_item_id is required"}
	}
	item, err := s.foods.GetByID(ctx, *req.FoodItemID)
	if err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: resolve food: %w", err)
	}
	f := req.QuantityGrams / 100.0
	source := req.Source
	if source == "" {
		source = "manual"
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}
	log := FoodLog{
		UserID:        userID,
		FoodItemID:    req.FoodItemID,
		LoggedAt:      loggedAt,
		MealSlot:      req.MealSlot,
		Source:        source,
		Description:   item.Name,
		QuantityGrams: req.QuantityGrams,
		Kcal:          item.KcalPer100g * f,
		ProteinG:      item.ProteinPer100g * f,
		CarbsG:        item.CarbsPer100g * f,
		FatG:          item.FatPer100g * f,
		FiberG:        item.FiberPer100g * f,
		Provenance:    item.Provenance,
		ClientLogMs:   req.ClientLogMs,
	}
	return s.logs.Create(ctx, log)
}

// EditRequest carries a partial edit to an existing log. Nil/zero fields mean
// "leave unchanged", except MealSlot which, when non-empty, is validated.
// CorrectionPhrase is the original user text that resolved to the WRONG food;
// when the food is changed and this is set, it is recorded as an alias
// (lower+trim) mapping the phrase to the corrected item so future resolves hit
// the alias tier. Nutrition is NEVER taken from the request — it is always
// recomputed from the (possibly new) food row.
type EditRequest struct {
	FoodItemID       *uuid.UUID `json:"food_item_id"`
	MealSlot         string     `json:"meal_slot"`
	QuantityGrams    *float64   `json:"quantity_grams"`
	LoggedAt         *time.Time `json:"logged_at"`
	CorrectionPhrase string     `json:"correction_phrase"`
}

func (s Service) EditLog(ctx context.Context, userID, logID uuid.UUID, req EditRequest) (FoodLog, error) {
	current, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: edit: load: %w", err)
	}

	if req.MealSlot != "" {
		if !validMealSlots[req.MealSlot] {
			return FoodLog{}, httpx.ValidationError{Message: "invalid meal_slot"}
		}
		current.MealSlot = req.MealSlot
	}
	if req.LoggedAt != nil {
		current.LoggedAt = *req.LoggedAt
	}

	foodChanged := req.FoodItemID != nil && (current.FoodItemID == nil || *req.FoodItemID != *current.FoodItemID)
	gramsChanged := req.QuantityGrams != nil && *req.QuantityGrams != current.QuantityGrams

	if req.QuantityGrams != nil {
		if *req.QuantityGrams <= 0 {
			return FoodLog{}, httpx.ValidationError{Message: "quantity_grams must be positive"}
		}
		current.QuantityGrams = *req.QuantityGrams
	}
	if req.FoodItemID != nil {
		current.FoodItemID = req.FoodItemID
	}

	// Recompute nutrition from the row whenever food or grams changed.
	if foodChanged || gramsChanged {
		if current.FoodItemID == nil {
			return FoodLog{}, httpx.ValidationError{Message: "food_item_id required to recompute nutrition"}
		}
		item, err := s.foods.GetByID(ctx, *current.FoodItemID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// The LOG exists (loaded above); it's the FOOD that's missing —
				// a client-supplied bad food_item_id, not a "log not found" case.
				return FoodLog{}, httpx.ValidationError{Message: "food_item_id not found"}
			}
			return FoodLog{}, fmt.Errorf("foodlog: edit: resolve food: %w", err)
		}
		f := current.QuantityGrams / 100.0
		current.Description = item.Name
		current.Kcal = item.KcalPer100g * f
		current.ProteinG = item.ProteinPer100g * f
		current.CarbsG = item.CarbsPer100g * f
		current.FatG = item.FatPer100g * f
		current.FiberG = item.FiberPer100g * f
		current.Provenance = item.Provenance
	}

	updated, err := s.logs.Update(ctx, current)
	if err != nil {
		return FoodLog{}, err
	}

	// Correction alias: record the original phrase -> corrected item so future
	// resolves auto-hit it. Best-effort — an alias write must not fail the edit.
	if foodChanged && req.CorrectionPhrase != "" && current.FoodItemID != nil {
		if aerr := s.foods.AddAlias(ctx, req.CorrectionPhrase, *current.FoodItemID); aerr != nil {
			// Best-effort: the edit already succeeded, so surface the alias
			// failure for observability but do not fail the request.
			slog.WarnContext(ctx, "foodlog: correction alias write failed",
				"error", aerr, "food_item_id", *current.FoodItemID, "user_id", userID)
		}
	}
	return updated, nil
}

// BatchItem is one food entry within a CreateBatchRequest. Only the food
// reference and quantity are client-supplied — all nutrition is recomputed
// server-side from the resolved FoodItem row.
type BatchItem struct {
	FoodItemID    uuid.UUID `json:"food_item_id"`
	QuantityGrams float64   `json:"quantity_grams"`
}

// CreateBatchRequest logs several foods as a single meal (e.g. all items on a
// plate) in one atomic call.
type CreateBatchRequest struct {
	LoggedAt time.Time   `json:"logged_at"`
	MealSlot string      `json:"meal_slot"`
	Items    []BatchItem `json:"items"`
}

// CreateBatch logs several foods as one meal in a single transaction. Macros
// are recomputed server-side per item (item per-100g × grams) — identical to
// the math in LogFood — so no client-supplied nutrition is ever trusted.
// All-or-nothing: if any item's food_item_id doesn't resolve, or has a
// non-positive quantity, the entire batch is rolled back and no logs are
// created.
func (s Service) CreateBatch(ctx context.Context, userID uuid.UUID, req CreateBatchRequest) ([]FoodLog, error) {
	if len(req.Items) == 0 {
		return nil, httpx.ValidationError{Message: "items must not be empty"}
	}
	if !validMealSlots[req.MealSlot] {
		return nil, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	loggedAt := req.LoggedAt
	if loggedAt.IsZero() {
		loggedAt = time.Now()
	}

	out := make([]FoodLog, 0, len(req.Items))
	err := s.logs.Transaction(ctx, func(txLogs Repository) error {
		for _, it := range req.Items {
			if it.QuantityGrams <= 0 {
				return httpx.ValidationError{Message: "quantity_grams must be positive"}
			}
			item, err := s.foods.GetByID(ctx, it.FoodItemID)
			if err != nil {
				return httpx.ValidationError{Message: "unknown food_item_id"}
			}
			fid := it.FoodItemID
			f := it.QuantityGrams / 100.0
			created, err := txLogs.Create(ctx, FoodLog{
				UserID:        userID,
				FoodItemID:    &fid,
				LoggedAt:      loggedAt,
				MealSlot:      req.MealSlot,
				Source:        "memory",
				Description:   item.Name,
				QuantityGrams: it.QuantityGrams,
				Kcal:          item.KcalPer100g * f,
				ProteinG:      item.ProteinPer100g * f,
				CarbsG:        item.CarbsPer100g * f,
				FatG:          item.FatPer100g * f,
				FiberG:        item.FiberPer100g * f,
				Provenance:    item.Provenance,
			})
			if err != nil {
				return err
			}
			out = append(out, created)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s Service) CopyDay(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (int, error) {
	src, err := s.logs.ListByUserAndDay(ctx, userID, from, loc)
	if err != nil {
		return 0, err
	}
	dayDelta := time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, loc).
		Sub(time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc))
	count := 0
	for _, l := range src {
		clone := l
		clone.ID = uuid.Nil
		clone.CreatedAt = time.Time{}
		clone.LoggedAt = l.LoggedAt.Add(dayDelta)
		if _, err := s.logs.Create(ctx, clone); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}

func (s Service) RepeatLog(ctx context.Context, userID, logID uuid.UUID, at time.Time) (FoodLog, error) {
	src, err := s.logs.GetByID(ctx, userID, logID)
	if err != nil {
		return FoodLog{}, err
	}
	clone := src
	clone.ID = uuid.Nil
	clone.CreatedAt = time.Time{}
	clone.LoggedAt = at
	return s.logs.Create(ctx, clone)
}
