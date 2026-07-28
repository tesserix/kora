package pins

import (
	"time"

	"github.com/google/uuid"
)

// Pin is a user-curated favorite food. One row per (user_id, food_item_id);
// grams + meal_slot capture the default portion to log when the pin is tapped.
type Pin struct {
	ID         uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID     uuid.UUID `gorm:"type:uuid;not null;index"`
	FoodItemID uuid.UUID `gorm:"type:uuid;not null"`
	Grams      float64   `gorm:"not null"`
	MealSlot   string    `gorm:"not null"`
	CreatedAt  time.Time
}

func (Pin) TableName() string { return "pins" }
