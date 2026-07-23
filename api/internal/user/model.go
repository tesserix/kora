// Package user owns the user profile domain.
package user

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	FirebaseUID string    `gorm:"uniqueIndex" json:"-"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`

	Sex            string     `json:"sex"`
	BirthYear      int        `json:"birth_year"`
	HeightCm       float64    `json:"height_cm"`
	WeightKg       float64    `json:"weight_kg"`
	ActivityLevel  string     `json:"activity_level"`
	Goal           string     `json:"goal"`
	TargetKcal     float64    `json:"target_kcal"`
	TargetProteinG float64    `json:"target_protein_g"`
	TargetCarbsG   float64    `json:"target_carbs_g"`
	TargetFatG     float64    `json:"target_fat_g"`
	OnboardedAt    *time.Time `json:"onboarded_at"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
