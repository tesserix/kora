// Package share owns circles: named sets of friends an owner grants categories
// to (kora#326). It writes the grants; package access reads them.
package share

import (
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
)

type Circle struct {
	ID        uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	OwnerID   uuid.UUID `json:"owner_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func (Circle) TableName() string { return "share_circles" }

// MemberView never exposes email -- same projection rule as social.FriendView.
type MemberView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}

type CircleView struct {
	ID         uuid.UUID         `json:"id"`
	Name       string            `json:"name"`
	Members    []MemberView      `json:"members"`
	Categories []access.Category `json:"categories"`
}
