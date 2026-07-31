// Package feedback captures in-app bug reports and feature requests from
// Kora users. It is capture-only: no comments, attachments, assignees, or
// status transitions. Field names deliberately mirror mark8ly's live
// marketplace-api ticket contract (subject, description, status) so a later
// tesserix-home integration is a projection rather than a redesign. kind has
// no mark8ly equivalent and is the entire point of the feature.
package feedback

import (
	"time"

	"github.com/google/uuid"
)

// Kind is what the user is telling us: a defect or a request.
type Kind string

const (
	KindBug     Kind = "bug"
	KindFeature Kind = "feature"
)

// Valid reports whether k is a recognised kind. Anything else is rejected at
// the handler rather than stored, so the column never accumulates values the
// mark8ly-aligned mapping cannot express.
func (k Kind) Valid() bool {
	return k == KindBug || k == KindFeature
}

// Status mirrors mark8ly's marketplace-api ticket status lifecycle. Kora
// only ever WRITES StatusOpen — the other values exist so the column can
// express the full lifecycle once an admin integration can triage feedback,
// the same way mark8ly's own tickets progress from open to closed.
type Status string

const (
	StatusOpen     Status = "open"
	StatusPending  Status = "pending"
	StatusResolved Status = "resolved"
	StatusClosed   Status = "closed"
)

// Valid reports whether s is a recognised status.
func (s Status) Valid() bool {
	return s == StatusOpen || s == StatusPending || s == StatusResolved || s == StatusClosed
}

// Feedback is one submission.
type Feedback struct {
	ID          uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey"`
	UserID      uuid.UUID `gorm:"type:uuid;not null;index"`
	Kind        Kind      `gorm:"not null"`
	Subject     string    `gorm:"not null"`
	Description string    `gorm:"not null"`
	Status      Status    `gorm:"not null;default:open"`
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
