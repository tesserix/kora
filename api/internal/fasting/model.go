// Package fasting stores DECLARED fasting intervals (kora#407).
//
// Kora's other fasting signal is inferred from an absence of food logs, which
// cannot distinguish "not eating" from "not logging" — see kora#408. This
// package exists so that a fast the user actually told us about is a fact
// rather than a guess. The two signals stay separate all the way through:
// a declared fast never feeds FastingStreakDays.
package fasting

import (
	"time"

	"github.com/google/uuid"
)

// CapHours bounds what any single fast can contribute, however long its row
// stays open. A user who taps start and never taps end -- or stops opening
// the app -- must not accrue an ever-growing fast that eventually trips the
// eating-disorder risk threshold on stale state. 48h leaves a genuine 24h+
// fast registering fully while an abandoned one plateaus.
const CapHours = 48

// EndedByUser is the only stored end reason. The food-log and cap endings are
// computed at read time and never written.
const EndedByUser = "user"

type Interval struct {
	ID        uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid()" json:"id"`
	UserID    uuid.UUID  `gorm:"type:uuid;not null" json:"user_id"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	EndedBy   *string    `json:"ended_by,omitempty"`
	LocalDate time.Time  `gorm:"type:date" json:"local_date"`
	CreatedAt time.Time  `json:"created_at"`
}

func (Interval) TableName() string { return "fasting_intervals" }
