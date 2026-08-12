package recipes

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
	maxRecipes     = 100
	maxNameLen     = 120
	maxRawTextLen  = 200
	maxIngredients = 60
	maxServings    = 100
)

var validSources = map[string]bool{SourceManual: true, SourcePaste: true, SourcePhoto: true}

// IngredientView is one rendered ingredient. Resolved == false means the food
// index has no match for RawText: the line is shown, contributes no macros,
// and is counted in RecipeView.UnresolvedCount.
type IngredientView struct {
	FoodItemID     *string  `json:"food_item_id"`
	Name           string   `json:"name"`
	RawText        string   `json:"raw_text"`
	Resolved       bool     `json:"resolved"`
	Grams          float64  `json:"grams"`
	EnteredAmount  *float64 `json:"entered_amount"`
	EnteredUnit    *string  `json:"entered_unit"`
	PortionAssumed bool     `json:"portion_assumed"`
	MatchScore     *float64 `json:"match_score"`
	MatchTier      *string  `json:"match_tier"`
	Kcal           float64  `json:"kcal"`
	ProteinG       float64  `json:"protein_g"`
	CarbsG         float64  `json:"carbs_g"`
	FatG           float64  `json:"fat_g"`
	FiberG         float64  `json:"fiber_g"`
}

// RecipeView carries BOTH totals and per-serving figures. Neither is stored:
// both are computed from live food rows on every read, so a correction to the
// food index shows up immediately instead of leaving a stale copy behind.
type RecipeView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Servings int    `json:"servings"`
	Source   string `json:"source"`

	Ingredients []IngredientView `json:"ingredients"`
	// UnresolvedCount lets the client say the total is PARTIAL rather than
	// implying completeness.
	UnresolvedCount int `json:"unresolved_count"`

	TotalKcal     float64 `json:"total_kcal"`
	TotalProteinG float64 `json:"total_protein_g"`
	TotalCarbsG   float64 `json:"total_carbs_g"`
	TotalFatG     float64 `json:"total_fat_g"`
	TotalFiberG   float64 `json:"total_fiber_g"`

	PerServingKcal     float64 `json:"per_serving_kcal"`
	PerServingProteinG float64 `json:"per_serving_protein_g"`
	PerServingCarbsG   float64 `json:"per_serving_carbs_g"`
	PerServingFatG     float64 `json:"per_serving_fat_g"`
	PerServingFiberG   float64 `json:"per_serving_fiber_g"`
}

// IngredientInput is one ingredient as submitted. FoodItemID nil means the
// user is deliberately keeping an unresolved line.
type IngredientInput struct {
	FoodItemID *string `json:"food_item_id"`
	RawText    string  `json:"raw_text"`
	Grams      float64 `json:"grams"`
	// EnteredAmount/EnteredUnit carry what was actually typed ("2 sachets").
	// When both are set the SERVER resolves them into Grams exactly once —
	// the client never converts, and the resolved grams drive every figure.
	EnteredAmount  *float64 `json:"entered_amount"`
	EnteredUnit    *string  `json:"entered_unit"`
	PortionAssumed bool     `json:"portion_assumed"`
	MatchScore     *float64 `json:"match_score"`
	MatchTier      *string  `json:"match_tier"`
	// Name is SERVER-POPULATED on a parse draft (parse.go's resolveIngredient
	// copies it from the matched food row) so the review sheet can show what
	// a resolved ingredient actually matched, without a second round trip.
	// Display only: IGNORED on create/update — validate() below re-derives
	// the canonical name from FoodItemID via the food row every time, so a
	// client-supplied value here is never trusted or validated.
	Name string `json:"name,omitempty"`
}

type SaveRecipeRequest struct {
	Name        string            `json:"name"`
	Servings    int               `json:"servings"`
	Source      string            `json:"source"`
	Ingredients []IngredientInput `json:"ingredients"`
}

type Service struct {
	repo  Repository
	foods nutrition.Repository
	batch BatchLogger
}

func NewService(repo Repository, foods nutrition.Repository) *Service {
	return &Service{repo: repo, foods: foods}
}

// resolveEnteredUnit resolves an entered (amount, unit) pair into grams
// against food, exactly once — mirroring savedmeals.resolveEnteredUnit and
// foodlog.resolveEnteredUnit so all three surfaces convert identically and
// report the same message.
func resolveEnteredUnit(amount float64, unit string, food nutrition.FoodItem) (float64, error) {
	grams, err := units.ResolveEntered(amount, unit, food.BaseUnit, food.ServingUnits)
	if err != nil {
		return 0, httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
	}
	return grams, nil
}

// validate checks the request and resolves each ingredient's food, returning
// the rows to persist and the enriched views to respond with.
func (s *Service) validate(ctx context.Context, req SaveRecipeRequest) (string, []Ingredient, []IngredientView, error) {
	name := strings.TrimSpace(req.Name)
	switch {
	case name == "":
		return "", nil, nil, httpx.ValidationError{Message: "name is required"}
	case len(name) > maxNameLen:
		return "", nil, nil, httpx.ValidationError{Message: "name is too long"}
	case req.Servings < 1:
		return "", nil, nil, httpx.ValidationError{Message: "servings must be at least 1"}
	case req.Servings > maxServings:
		return "", nil, nil, httpx.ValidationError{Message: "servings is too large"}
	case !validSources[req.Source]:
		return "", nil, nil, httpx.ValidationError{Message: "invalid source"}
	case len(req.Ingredients) == 0:
		return "", nil, nil, httpx.ValidationError{Message: "at least one ingredient is required"}
	case len(req.Ingredients) > maxIngredients:
		return "", nil, nil, httpx.ValidationError{Message: "too many ingredients"}
	}

	items := make([]Ingredient, 0, len(req.Ingredients))
	views := make([]IngredientView, 0, len(req.Ingredients))
	for _, in := range req.Ingredients {
		raw := strings.TrimSpace(in.RawText)
		if raw == "" {
			return "", nil, nil, httpx.ValidationError{Message: "each ingredient needs a description"}
		}
		if len(raw) > maxRawTextLen {
			return "", nil, nil, httpx.ValidationError{Message: "ingredient description is too long"}
		}

		// An UNRESOLVED ingredient is a first-class, valid state: it is kept
		// verbatim, contributes nothing, and is reported. Dropping it would
		// understate the recipe silently; guessing a food would misstate it.
		if in.FoodItemID == nil {
			items = append(items, Ingredient{RawText: raw})
			views = append(views, IngredientView{RawText: raw, Resolved: false})
			continue
		}

		fid, err := uuid.Parse(*in.FoodItemID)
		if err != nil {
			return "", nil, nil, httpx.ValidationError{Message: "invalid food_item_id"}
		}
		food, err := s.foods.GetByID(ctx, fid)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return "", nil, nil, httpx.ValidationError{Message: "unknown food_item_id"}
			}
			return "", nil, nil, fmt.Errorf("recipes: resolve food: %w", err)
		}

		grams := in.Grams
		assumed := in.PortionAssumed
		if in.EnteredAmount != nil && in.EnteredUnit != nil {
			grams, err = resolveEnteredUnit(*in.EnteredAmount, *in.EnteredUnit, food)
			if err != nil {
				return "", nil, nil, err
			}
		}
		if grams <= 0 {
			// An ingredient that has just been MATCHED carries no portion: it
			// was persisted unresolved (grams 0 — see the branch above) and the
			// client only had a food to add, not an amount. Rejecting it here
			// made "Find a match" unsaveable forever, so the server supplies
			// the same default parse.go applies on the parse path — and, per
			// #138, always flags it as an estimate so a guess can never render
			// as a measurement.
			grams, assumed = assumedPortionGrams(food)
		}

		items = append(items, Ingredient{
			FoodItemID: &fid, RawText: raw, Grams: grams,
			EnteredAmount: in.EnteredAmount, EnteredUnit: in.EnteredUnit,
			PortionAssumed: assumed,
			MatchScore:     in.MatchScore, MatchTier: in.MatchTier,
		})
		idStr := fid.String()
		f := grams / 100.0
		views = append(views, IngredientView{
			FoodItemID: &idStr, Name: food.Name, RawText: raw, Resolved: true, Grams: grams,
			EnteredAmount: in.EnteredAmount, EnteredUnit: in.EnteredUnit,
			PortionAssumed: assumed,
			MatchScore:     in.MatchScore, MatchTier: in.MatchTier,
			Kcal:     food.KcalPer100g * f,
			ProteinG: food.ProteinPer100g * f,
			CarbsG:   food.CarbsPer100g * f,
			FatG:     food.FatPer100g * f,
			FiberG:   food.FiberPer100g * f,
		})
	}
	return name, items, views, nil
}

// viewFrom sums the ingredient views into totals and divides by servings.
// This is the ONLY place per-serving figures are produced.
func viewFrom(id, name, source string, servings int, ivs []IngredientView) RecipeView {
	v := RecipeView{ID: id, Name: name, Servings: servings, Source: source, Ingredients: ivs}
	for _, iv := range ivs {
		if !iv.Resolved {
			v.UnresolvedCount++
			continue
		}
		v.TotalKcal += iv.Kcal
		v.TotalProteinG += iv.ProteinG
		v.TotalCarbsG += iv.CarbsG
		v.TotalFatG += iv.FatG
		v.TotalFiberG += iv.FiberG
	}
	if servings > 0 {
		d := float64(servings)
		v.PerServingKcal = v.TotalKcal / d
		v.PerServingProteinG = v.TotalProteinG / d
		v.PerServingCarbsG = v.TotalCarbsG / d
		v.PerServingFatG = v.TotalFatG / d
		v.PerServingFiberG = v.TotalFiberG / d
	}
	return v
}

// viewFromRows builds a view from persisted joined rows (the read path).
func viewFromRows(rec Recipe, rows []IngredientRow) RecipeView {
	ivs := make([]IngredientView, 0, len(rows))
	for _, r := range rows {
		iv := IngredientView{
			RawText: r.RawText, Grams: r.Grams,
			EnteredAmount: r.EnteredAmount, EnteredUnit: r.EnteredUnit,
			PortionAssumed: r.PortionAssumed,
			MatchScore:     r.MatchScore, MatchTier: r.MatchTier,
			Resolved: r.FoodItemID != nil,
		}
		if r.FoodItemID != nil {
			id := r.FoodItemID.String()
			iv.FoodItemID = &id
			iv.Name = r.Name
			f := r.Grams / 100.0
			iv.Kcal = r.KcalPer100g * f
			iv.ProteinG = r.ProteinPer100g * f
			iv.CarbsG = r.CarbsPer100g * f
			iv.FatG = r.FatPer100g * f
			iv.FiberG = r.FiberPer100g * f
		}
		ivs = append(ivs, iv)
	}
	return viewFrom(rec.ID.String(), rec.Name, rec.Source, rec.Servings, ivs)
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]RecipeView, error) {
	recs, err := s.repo.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 {
		return []RecipeView{}, nil
	}
	ids := make([]uuid.UUID, len(recs))
	for i, r := range recs {
		ids[i] = r.ID
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, ids)
	if err != nil {
		return nil, err
	}
	byRecipe := map[uuid.UUID][]IngredientRow{}
	for _, r := range rows {
		byRecipe[r.RecipeID] = append(byRecipe[r.RecipeID], r)
	}
	out := make([]RecipeView, 0, len(recs))
	for _, rec := range recs {
		out = append(out, viewFromRows(rec, byRecipe[rec.ID]))
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, userID, recipeID uuid.UUID) (RecipeView, error) {
	rec, err := s.repo.GetForUser(ctx, userID, recipeID)
	if err != nil {
		return RecipeView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	rows, err := s.repo.IngredientsForRecipes(ctx, []uuid.UUID{rec.ID})
	if err != nil {
		return RecipeView{}, err
	}
	return viewFromRows(rec, rows), nil
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, req SaveRecipeRequest) (RecipeView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return RecipeView{}, err
	}
	count, err := s.repo.CountForUser(ctx, userID)
	if err != nil {
		return RecipeView{}, err
	}
	if count >= maxRecipes {
		return RecipeView{}, httpx.ValidationError{Message: "recipe limit reached"}
	}
	rec, err := s.repo.Create(ctx, Recipe{
		UserID: userID, Name: name, Servings: req.Servings, Source: req.Source,
	}, items)
	if err != nil {
		return RecipeView{}, err
	}
	return viewFrom(rec.ID.String(), name, req.Source, req.Servings, views), nil
}

func (s *Service) Update(ctx context.Context, userID, recipeID uuid.UUID, req SaveRecipeRequest) (RecipeView, error) {
	name, items, views, err := s.validate(ctx, req)
	if err != nil {
		return RecipeView{}, err
	}
	if err := s.repo.Replace(ctx, userID, recipeID, name, req.Servings, items); err != nil {
		return RecipeView{}, err // gorm.ErrRecordNotFound → handler maps to 404
	}
	return viewFrom(recipeID.String(), name, req.Source, req.Servings, views), nil
}

func (s *Service) Delete(ctx context.Context, userID, recipeID uuid.UUID) error {
	return s.repo.DeleteForUser(ctx, userID, recipeID)
}
