package savedmeals

import (
	"time"

	"github.com/google/uuid"
)

type SavedMeal struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index"`
	Name      string    `gorm:"not null"`
	MealSlot  string    `gorm:"not null"`
	CreatedAt time.Time
}

func (SavedMeal) TableName() string { return "saved_meals" }

type SavedMealItem struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	SavedMealID uuid.UUID `gorm:"type:uuid;not null;index"`
	FoodItemID  uuid.UUID `gorm:"type:uuid;not null"`
	Grams       float64   `gorm:"not null"`
	Position    int       `gorm:"not null"`
}

func (SavedMealItem) TableName() string { return "saved_meal_items" }

// ItemRow is a joined read of an item with its food's name + per-100g macros,
// so List can enrich without an N+1 GetByID per item.
type ItemRow struct {
	SavedMealID    uuid.UUID
	FoodItemID     uuid.UUID
	Grams          float64
	Position       int
	Name           string
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}
