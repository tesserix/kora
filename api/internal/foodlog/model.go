// Package foodlog owns logged food-consumption events.
package foodlog

import (
	"time"

	"github.com/google/uuid"
)

type FoodLog struct {
	ID         uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID     uuid.UUID  `json:"-"`
	FoodItemID *uuid.UUID `json:"food_item_id,omitempty"`
	LoggedAt   time.Time  `json:"logged_at"`
	// LocalDate is the calendar day this log belongs to, in the DEVICE's zone
	// at the moment of capture. Decided once at write time and never re-derived
	// from the profile timezone at read time, so changing that timezone cannot
	// move a log to a different day. See kora#84 and internal/localday.
	LocalDate     time.Time `gorm:"type:date;not null" json:"local_date"`
	MealSlot      string    `json:"meal_slot"`
	Source        string    `json:"source"`
	Description   string    `json:"description"`
	QuantityGrams float64   `json:"quantity_grams"`
	EnteredAmount *float64  `gorm:"column:entered_amount" json:"entered_amount,omitempty"`
	EnteredUnit   *string   `gorm:"column:entered_unit" json:"entered_unit,omitempty"`
	Kcal          float64   `json:"kcal"`
	ProteinG      float64   `json:"protein_g"`
	CarbsG        float64   `json:"carbs_g"`
	FatG          float64   `json:"fat_g"`
	FiberG        float64   `json:"fiber_g"`
	Provenance    string    `json:"provenance"`
	// PortionAssumed reports that the system chose this portion rather than
	// deriving it from a serving size or receiving it from the user. It is a
	// LABEL, never an input to arithmetic — nutrition and day totals are
	// unaffected by it. Cleared when the user edits the portion by hand.
	PortionAssumed bool `gorm:"not null;default:false" json:"portion_assumed"`
	// InputPhrase is the raw text the user said or typed, kept only for
	// resolve-sourced logs so a later correction can teach the index which
	// phrase resolved wrong. Description holds the RESOLVED food's name;
	// these are deliberately different fields.
	InputPhrase *string   `json:"input_phrase,omitempty"`
	ClientLogMs *int      `json:"client_log_ms,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	// BaseUnit is the LOGGED FOOD's base unit ("g" or "ml"), joined in from
	// food_items — it is not a column on food_logs, which is why it is
	// read-only to gorm ("->") and excluded from migration.
	//
	// It exists so a client can label a LEGACY row correctly. A legacy log
	// carries no entered pair at all, so quantity_grams is the only figure
	// there is, and without the food's base unit a 300 ml drink renders as
	// "300 g". It is a LABEL, never an input to arithmetic: nutrition is
	// computed server-side from quantity_grams and the food's per-100
	// figures, and no client converts anything with this.
	//
	// Empty when the log resolved to no food item, or was read through a path
	// that does not join (e.g. the idempotent-replay reload).
	BaseUnit string `gorm:"->;-:migration" json:"base_unit,omitempty"`
}
