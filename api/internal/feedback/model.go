// Package feedback captures in-app bug reports and feature requests from
// Kora users. It is capture-only: no comments, attachments, assignees, or
// status transitions. Field names deliberately mirror the platform
// tickets-service Ticket contract so a later tesserix-home integration is a
// projection rather than a redesign.
package feedback

import (
	"time"

	"github.com/google/uuid"
)

// Kind is what the user is telling us: a defect or a request.
// Values map to tickets-service TicketType BUG / FEATURE.
type Kind string

const (
	KindBug     Kind = "bug"
	KindFeature Kind = "feature"
)

// Valid reports whether k is a recognised kind. Anything else is rejected at
// the handler rather than stored, so the column never accumulates values the
// tickets-service mapping cannot express.
func (k Kind) Valid() bool {
	return k == KindBug || k == KindFeature
}

// Status mirrors tickets-service TicketStatus. Kora only ever writes Open —
// triage happens in admin once the integration exists.
type Status string

const StatusOpen Status = "open"

// Feedback is one submission.
type Feedback struct {
	ID     uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID uuid.UUID `gorm:"type:uuid;not null;index"`
	Kind   Kind      `gorm:"not null"`
	Title  string    `gorm:"not null"`
	Body   string    `gorm:"not null"`
	Status Status    `gorm:"not null;default:open"`
	// Client context, sent by the app. It is display-only — never trusted for
	// authorisation — and makes a bug report actionable ("crashed on iOS 26.1,
	// app 1.0.0" rather than "it crashed").
	AppVersion  string `gorm:"not null;default:''"`
	Platform    string `gorm:"not null;default:''"`
	OSVersion   string `gorm:"not null;default:''"`
	DeviceModel string `gorm:"not null;default:''"`
	CreatedAt   time.Time
}

func (Feedback) TableName() string { return "feedback" }
