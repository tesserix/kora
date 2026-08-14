// Package tracking owns water and weight entries.
package tracking

import (
	"time"

	"github.com/google/uuid"
)

type WaterEntry struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID   uuid.UUID `json:"-"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the calendar day this entry belongs to, in the DEVICE's zone
	// at capture. Fixed at write time so a profile timezone change cannot move
	// it to another day. See kora#84 and internal/localday.
	LocalDate time.Time `gorm:"type:date;not null" json:"local_date"`
	VolumeML  int       `json:"volume_ml"`
	CreatedAt time.Time `json:"created_at"`
}

type WeightEntry struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID   uuid.UUID `json:"-"`
	WeightKg float64   `json:"weight_kg"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the calendar day this entry belongs to, in the DEVICE's zone
	// at capture. Fixed at write time so a profile timezone change cannot move
	// it to another day. See kora#84 and internal/localday.
	LocalDate time.Time `gorm:"type:date;not null" json:"local_date"`
	CreatedAt time.Time `json:"created_at"`
}
