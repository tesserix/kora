package pins

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const maxPins = 100

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

// PinnedFood is the enriched, client-facing shape — same fields as memory.Food
// minus count/last_logged_at, so mobile renders and logs it identically.
type PinnedFood struct {
	FoodItemID string  `json:"food_item_id"`
	Name       string  `json:"name"`
	MealSlot   string  `json:"meal_slot"`
	Grams      float64 `json:"grams"`
	Kcal       float64 `json:"kcal"`
	ProteinG   float64 `json:"protein_g"`
	CarbsG     float64 `json:"carbs_g"`
	FatG       float64 `json:"fat_g"`
	FiberG     float64 `json:"fiber_g"`
}

type CreatePinRequest struct {
	FoodItemID string  `json:"food_item_id"`
	Grams      float64 `json:"grams"`
	MealSlot   string  `json:"meal_slot"`
}

type Service struct {
	repo  Repository
	foods nutrition.Repository
}

func NewService(repo Repository, foods nutrition.Repository) Service {
	return Service{repo: repo, foods: foods}
}

func enrich(item nutrition.FoodItem, grams float64, slot string) PinnedFood {
	f := grams / 100.0
	return PinnedFood{
		FoodItemID: item.ID.String(),
		Name:       item.Name,
		MealSlot:   slot,
		Grams:      grams,
		Kcal:       item.KcalPer100g * f,
		ProteinG:   item.ProteinPer100g * f,
		CarbsG:     item.CarbsPer100g * f,
		FatG:       item.FatPer100g * f,
		FiberG:     item.FiberPer100g * f,
	}
}

// List returns the user's pins enriched with name + macros.
func (s Service) List(ctx context.Context, userID uuid.UUID) ([]PinnedFood, error) {
	pins, err := s.repo.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]PinnedFood, 0, len(pins))
	for _, p := range pins {
		item, err := s.foods.GetByID(ctx, p.FoodItemID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue // food removed out from under the pin (FK CASCADE normally prevents this)
			}
			return nil, fmt.Errorf("pins: enrich: %w", err)
		}
		out = append(out, enrich(item, p.Grams, p.MealSlot))
	}
	return out, nil
}

// Create validates and upserts a pin, returning the enriched food.
func (s Service) Create(ctx context.Context, userID uuid.UUID, req CreatePinRequest) (PinnedFood, error) {
	if req.Grams <= 0 {
		return PinnedFood{}, httpx.ValidationError{Message: "grams must be positive"}
	}
	if !validMealSlots[req.MealSlot] {
		return PinnedFood{}, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	foodID, err := uuid.Parse(req.FoodItemID)
	if err != nil {
		return PinnedFood{}, httpx.ValidationError{Message: "invalid food_item_id"}
	}
	item, err := s.foods.GetByID(ctx, foodID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return PinnedFood{}, httpx.ValidationError{Message: "unknown food_item_id"}
		}
		return PinnedFood{}, fmt.Errorf("pins: resolve food: %w", err)
	}
	// Enforce the cap only when adding a NEW pin (re-pinning an existing food is fine).
	count, err := s.repo.CountForUser(ctx, userID)
	if err != nil {
		return PinnedFood{}, err
	}
	if count >= maxPins {
		existing, err := s.repo.ListForUser(ctx, userID)
		if err != nil {
			return PinnedFood{}, err
		}
		if !containsFood(existing, foodID) {
			return PinnedFood{}, httpx.ValidationError{Message: "pin limit reached"}
		}
	}
	if _, err := s.repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: foodID, Grams: req.Grams, MealSlot: req.MealSlot}); err != nil {
		return PinnedFood{}, err
	}
	return enrich(item, req.Grams, req.MealSlot), nil
}

func (s Service) Delete(ctx context.Context, userID, foodItemID uuid.UUID) error {
	return s.repo.DeleteForUser(ctx, userID, foodItemID)
}

func containsFood(pins []Pin, foodID uuid.UUID) bool {
	for _, p := range pins {
		if p.FoodItemID == foodID {
			return true
		}
	}
	return false
}
