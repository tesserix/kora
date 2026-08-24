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
// stays open, so an abandoned fast's duration cannot grow without limit. It
// alone does NOT stop a permanently-open, long-abandoned fast from tripping
// the eating-disorder risk threshold forever -- 48h is still >=
// riskDeclaredFastHours, so it plateaus AT a risk-triggering value rather
// than escaping one. What actually retires a stale fast is
// coach.BuildContext skipping any interval whose effective end has aged out
// of the 7-day window entirely (kora#407 Decision 4: a fast counts only if
// it INTERSECTS the window). 48h leaves a genuine 24h+ fast registering
// fully while an abandoned one, once its capped effective end falls outside
// the window, stops counting at all.
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
