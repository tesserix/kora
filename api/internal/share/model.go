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
//
// AvatarURL is "" for a user with no picture -- the client falls back to
// initials on empty, same rule as social.FriendView.AvatarURL.
type MemberView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	AvatarURL   string    `json:"avatar_url"`
}

// MembershipView is the MEMBER's view of a circle they were added to
// (kora#440) — the mirror of CircleView, and deliberately not the same shape.
//
// It carries NO circle name. Circle names are private labels the owner writes
// for their own use — "Gym crew", "Family (not Mum)" — and showing a member
// which bucket they were filed under exposes a judgement the owner never chose
// to share. What a member actually needs in order to decide whether to leave
// is who is sharing, what they are sharing, and an id to act on.
//
// Owner is projected without email, the same rule as MemberView and
// social.FriendView.
type MembershipView struct {
	CircleID   uuid.UUID         `json:"circle_id"`
	Owner      MemberView        `json:"owner"`
	Categories []access.Category `json:"categories"`
}

type CircleView struct {
	ID         uuid.UUID         `json:"id"`
	Name       string            `json:"name"`
	Members    []MemberView      `json:"members"`
	Categories []access.Category `json:"categories"`
}
