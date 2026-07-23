// Package tracking owns water and weight entries.
package tracking

import (
	"time"

	"github.com/google/uuid"
)

type WaterEntry struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID    uuid.UUID `json:"-"`
	LoggedAt  time.Time `json:"logged_at"`
	VolumeML  int       `json:"volume_ml"`
	CreatedAt time.Time `json:"created_at"`
}
