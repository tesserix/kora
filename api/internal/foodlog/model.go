// Package foodlog owns logged food-consumption events.
package foodlog

import (
	"time"

	"github.com/google/uuid"
)

type FoodLog struct {
	ID            uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID        uuid.UUID  `json:"-"`
	FoodItemID    *uuid.UUID `json:"food_item_id,omitempty"`
	LoggedAt      time.Time  `json:"logged_at"`
	MealSlot      string     `json:"meal_slot"`
	Source        string     `json:"source"`
	Description   string     `json:"description"`
	QuantityGrams float64    `json:"quantity_grams"`
	Kcal          float64    `json:"kcal"`
	ProteinG      float64    `json:"protein_g"`
	CarbsG        float64    `json:"carbs_g"`
	FatG          float64    `json:"fat_g"`
	FiberG        float64    `json:"fiber_g"`
	Provenance    string     `json:"provenance"`
	// InputPhrase is the raw text the user said or typed, kept only for
	// resolve-sourced logs so a later correction can teach the index which
	// phrase resolved wrong. Description holds the RESOLVED food's name;
	// these are deliberately different fields.
	InputPhrase   *string    `json:"input_phrase,omitempty"`
	ClientLogMs   *int       `json:"client_log_ms,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}
