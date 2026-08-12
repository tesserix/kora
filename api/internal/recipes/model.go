// Package recipes owns user-authored, servings-aware dishes that can be
// logged repeatedly. A recipe differs from a saved meal: a saved meal is
// "log this exact plate again" (fixed grams), a recipe is "this dish yields
// N servings — log me 1.5 of them", and its ingredients may be unresolved
// raw text an AI extraction could not match to the food index.
package recipes

import (
	"time"

	"github.com/google/uuid"
)

// Recipe sources. A recipe records how it was created so the UI can explain
// why an ingredient carries model confidence.
const (
	SourceManual = "manual"
	SourcePaste  = "paste"
	SourcePhoto  = "photo"
)

type Recipe struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID   uuid.UUID `gorm:"type:uuid;not null;index"`
	Name     string    `gorm:"not null"`
	Servings int       `gorm:"not null"`
	Source   string    `gorm:"not null"`
	// autoCreateTime/autoUpdateTime are REQUIRED: a bare time.Time with no
	// tag inserts Go's zero time and overrides the SQL DEFAULT now(). This
	// cost an Important review finding on the groups package.
	CreatedAt time.Time `gorm:"autoCreateTime"`
	UpdatedAt time.Time `gorm:"autoUpdateTime"`
}

func (Recipe) TableName() string { return "recipes" }

// Ingredient is one line of a recipe. FoodItemID is nil when the food index
// could not resolve RawText — the ingredient is kept, contributes no macros,
// and is reported to the user rather than dropped or guessed at.
type Ingredient struct {
	ID         uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	RecipeID   uuid.UUID  `gorm:"type:uuid;not null;index"`
	Position   int        `gorm:"not null"`
	FoodItemID *uuid.UUID `gorm:"type:uuid"`
	// RawText is kept even when resolution succeeds: it is what the user or
	// the model actually wrote, and what a later re-resolution needs. Same
	// rationale as food_logs.input_phrase living beside description.
	RawText       string   `gorm:"not null"`
	Grams         float64  `gorm:"not null;default:0"`
	EnteredAmount *float64 `gorm:"column:entered_amount"`
	EnteredUnit   *string  `gorm:"column:entered_unit"`
	// PortionAssumed reports that no serving size was known and the grams
	// below are a system estimate, not a measurement. It must survive save →
	// read → log; see issue #138 for what happens when it does not.
	PortionAssumed bool `gorm:"not null;default:false"`
	// MatchScore/MatchTier are nil when the user picked the food themselves
	// — no model confidence exists to record, which is different from low
	// confidence and is rendered differently.
	MatchScore *float64 `gorm:"column:match_score"`
	MatchTier  *string  `gorm:"column:match_tier"`
}

func (Ingredient) TableName() string { return "recipe_ingredients" }

// IngredientRow is a joined read of an ingredient with its food's name and
// per-100g macros, so list/detail reads enrich without an N+1 GetByID.
//
// The join behind this is a LEFT JOIN, unlike savedmeals.ItemsForMeals'
// INNER JOIN, because food_item_id is nullable here — an INNER JOIN would
// silently drop every unresolved ingredient, which is the exact silent
// shrinkage the nullable column exists to prevent. Name and the per-100g
// figures are therefore zero-valued for an unresolved row.
type IngredientRow struct {
	RecipeID       uuid.UUID
	FoodItemID     *uuid.UUID
	Position       int
	RawText        string
	Grams          float64
	EnteredAmount  *float64
	EnteredUnit    *string
	PortionAssumed bool
	MatchScore     *float64
	MatchTier      *string
	Name           string
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}
