package coach

import (
	"time"

	"github.com/google/uuid"
)

// TurnRole identifies who authored a stored coach turn.
type TurnRole string

const (
	TurnRoleUser TurnRole = "user"
	TurnRoleOtto TurnRole = "otto"
)

// Turn is one persisted message in a user's coach thread. Turns are stored
// for replay only — they are never fed back into the model's prompt, so an
// answer is always grounded solely on the deterministic Context computed at
// the time it was asked.
type Turn struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index"`
	Role      TurnRole  `gorm:"not null"`
	Text      string    `gorm:"not null"`
	CreatedAt time.Time
}

func (Turn) TableName() string { return "coach_turns" }

// TurnCitation is one grounding fact cited by an Otto turn. Position
// preserves display order rather than relying on insertion order.
type TurnCitation struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	TurnID   uuid.UUID `gorm:"type:uuid;not null;index"`
	Label    string    `gorm:"not null"`
	Value    string    `gorm:"not null"`
	Position int       `gorm:"not null"`
}

func (TurnCitation) TableName() string { return "coach_turn_citations" }
