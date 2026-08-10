package savedmeals

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

const (
	maxSavedMeals = 50
	maxNameLen    = 80
)

var validMealSlots = map[string]bool{"breakfast": true, "lunch": true, "dinner": true, "snack": true}

type SavedMealItemView struct {
	FoodItemID string  `json:"food_item_id"`
	Name       string  `json:"name"`
	Grams      float64 `json:"grams"`
	// EnteredAmount/EnteredUnit echo back what the user actually typed
	// ("1 sachet"); nil for a legacy gram-entered item. Grams (above) is
	// always what every nutrition figure on this item is computed from.
	EnteredAmount *float64 `json:"entered_amount"`
	EnteredUnit   *string  `json:"entered_unit"`
	Kcal          float64  `json:"kcal"`
	ProteinG      float64  `json:"protein_g"`
	CarbsG        float64  `json:"carbs_g"`
	FatG          float64  `json:"fat_g"`
	FiberG        float64  `json:"fiber_g"`
}

type SavedMealView struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	MealSlot string              `json:"meal_slot"`
	Items    []SavedMealItemView `json:"items"`
	Kcal     float64             `json:"kcal"`
	ProteinG float64             `json:"protein_g"`
	CarbsG   float64             `json:"carbs_g"`
	FatG     float64             `json:"fat_g"`
	FiberG   float64             `json:"fiber_g"`
}

type SaveMealRequest struct {
	Name     string `json:"name"`
	MealSlot string `json:"meal_slot"`
	Items    []struct {
		FoodItemID string  `json:"food_item_id"`
		Grams      float64 `json:"grams"`
		// EnteredAmount/EnteredUnit carry what the user actually typed ("1
		// sachet"). When both are set, the server resolves them into Grams
		// exactly once here — the client never converts, and the resolved
		// grams (not the entered pair) drive every nutrition figure. Nil
		// means a legacy gram-entered item; Grams is used as-is.
		EnteredAmount *float64 `json:"entered_amount"`
		EnteredUnit   *string  `json:"entered_unit"`
	} `json:"items"`
}

type Service struct {
	repo  Repository
	foods nutrition.Repository
}

func NewService(repo Repository, foods nutrition.Repository) *Service {
	return &Service{repo: repo, foods: foods}
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]SavedMealView, error) {
	meals, err := s.repo.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(meals) == 0 {
		return []SavedMealView{}, nil
	}
	ids := make([]uuid.UUID, len(meals))
	for i, m := range meals {
		ids[i] = m.ID
	}
	rows, err := s.repo.ItemsForMeals(ctx, ids)
	if err != nil {
		return nil, err
	}
	byMeal := map[uuid.UUID][]ItemRow{}
	for _, r := range rows {
		byMeal[r.SavedMealID] = append(byMeal[r.SavedMealID], r)
	}
	out := make([]SavedMealView, 0, len(meals))
	for _, m := range meals {
		v := SavedMealView{ID: m.ID.String(), Name: m.Name, MealSlot: m.MealSlot, Items: []SavedMealItemView{}}
		for _, it := range byMeal[m.ID] {
			f := it.Grams / 100.0
			iv := SavedMealItemView{
				FoodItemID: it.FoodItemID.String(), Name: it.Name, Grams: it.Grams,
				EnteredAmount: it.EnteredAmount, EnteredUnit: it.EnteredUnit,
				Kcal: it.KcalPer100g * f, ProteinG: it.ProteinPer100g * f, CarbsG: it.CarbsPer100g * f,
				FatG: it.FatPer100g * f, FiberG: it.FiberPer100g * f,
			}
			v.Items = append(v.Items, iv)
			v.Kcal += iv.Kcal
			v.ProteinG += iv.ProteinG
			v.CarbsG += iv.CarbsG
			v.FatG += iv.FatG
			v.FiberG += iv.FiberG
		}
		out = append(out, v)
	}
	return out, nil
}

// resolveEnteredUnit resolves an entered (amount, unit) pair into grams
// against food, exactly once, mirroring foodlog.resolveEnteredUnit (see that
// function's doc for the write-once-server-side rationale). The actual
// resolution (decode ServingUnits + ToBase) lives in units.ResolveEntered,
// shared with foodlog, so both surfaces resolve identically — this wrapper
// only extracts the fields units.ResolveEntered needs from a
// nutrition.FoodItem and translates its error into an httpx.ValidationError
// using units.UnrecognisedUnitMessage, since the units package itself stays
// free of both the nutrition and httpx dependencies.
func resolveEnteredUnit(amount float64, unit string, food nutrition.FoodItem) (float64, error) {
	grams, err := units.ResolveEntered(amount, unit, food.BaseUnit, food.ServingUnits)
	if err != nil {
		return 0, httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
	}
	return grams, nil
}

// validate checks the request and resolves each food item, returning the parsed
// items and (for Create's response) the enriched view built from live food data.
func (s *Service) validate(ctx context.Context, req SaveMealRequest) (string, []SavedMealItem, []SavedMealItemView, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return "", nil, nil, httpx.ValidationError{Message: "name is required"}
	}
	if len(name) > maxNameLen {
		return "", nil, nil, httpx.ValidationError{Message: "name is too long"}
	}
	if !validMealSlots[req.MealSlot] {
		return "", nil, nil, httpx.ValidationError{Message: "invalid meal_slot"}
	}
	if len(req.Items) == 0 {
		return "", nil, nil, httpx.ValidationError{Message: "at least one item is required"}
	}
	items := make([]SavedMealItem, 0, len(req.Items))
	views := make([]SavedMealItemView, 0, len(req.Items))
	for _, it := range req.Items {
		fid, err := uuid.Parse(it.FoodItemID)
		if err != nil {
			return "", nil, nil, httpx.ValidationError{Message: "invalid food_item_id"}
		}
		food, err := s.foods.GetByID(ctx, fid)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return "", nil, nil, httpx.ValidationError{Message: "unknown food_item_id"}
			}
			return "", nil, nil, fmt.Errorf("savedmeals: resolve food: %w", err)
		}

		// When the caller entered a unit, the SERVER derives grams from it —
		// the client never converts. Resolution happens exactly once, here,
		// and the result (never the entered pair) is what every nutrition
		// figure on the item is computed from.
		grams := it.Grams
		if it.EnteredAmount != nil && it.EnteredUnit != nil {
			grams, err = resolveEnteredUnit(*it.EnteredAmount, *it.EnteredUnit, food)
			if err != nil {
				return "", nil, nil, err
			}
		}
		if grams <= 0 {
			return "", nil, nil, httpx.ValidationError{Message: "grams must be positive"}
		}

		items = append(items, SavedMealItem{
			FoodItemID: fid, Grams: grams,
			EnteredAmount: it.EnteredAmount, EnteredUnit: it.EnteredUnit,
		})
		f := grams / 100.0
		views = append(views, SavedMealItemView{
			FoodItemID: fid.String(), Name: food.Name, Grams: grams,
			EnteredAmount: it.EnteredAmount, EnteredUnit: it.EnteredUnit,
			Kcal: food.KcalPer100g * f, ProteinG: food.ProteinPer100g * f, CarbsG: food.CarbsPer100g * f,
			FatG: food.FatPer100g * f, FiberG: food.FiberPer100g * f,
		})
	}
	return name, items, views, nil
}

func viewFrom(id, name, slot string, itemViews []SavedMealItemView) SavedMealView {
	v := SavedMealView{ID: id, Name: name, MealSlot: slot, Items: itemViews}
	for _, iv := range itemViews {
		v.Kcal += iv.Kcal
		v.ProteinG += iv.ProteinG
		v.CarbsG += iv.CarbsG
		v.FatG += iv.FatG
		v.FiberG += iv.FiberG
	}
	return v
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, req SaveMealRequest) (SavedMealView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return SavedMealView{}, err
	}
	count, err := s.repo.CountForUser(ctx, userID)
	if err != nil {
		return SavedMealView{}, err
	}
	if count >= maxSavedMeals {
		return SavedMealView{}, httpx.ValidationError{Message: "saved-meal limit reached"}
	}
	m, err := s.repo.Create(ctx, SavedMeal{UserID: userID, Name: name, MealSlot: req.MealSlot}, items)
	if err != nil {
		return SavedMealView{}, err
	}
	return viewFrom(m.ID.String(), name, req.MealSlot, views), nil
}

func (s *Service) Update(ctx context.Context, userID, mealID uuid.UUID, req SaveMealRequest) (SavedMealView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return SavedMealView{}, err
	}
	if err := s.repo.Replace(ctx, userID, mealID, name, req.MealSlot, items); err != nil {
		return SavedMealView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	return viewFrom(mealID.String(), name, req.MealSlot, views), nil
}

func (s *Service) Delete(ctx context.Context, userID, mealID uuid.UUID) error {
	return s.repo.DeleteForUser(ctx, userID, mealID)
}
