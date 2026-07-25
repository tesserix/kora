// Package social owns the friendship graph.
package social

import (
	"time"

	"github.com/google/uuid"
)

type FriendStatus string

const (
	FriendStatusPending  FriendStatus = "pending"
	FriendStatusAccepted FriendStatus = "accepted"
)

type Friendship struct {
	ID          uuid.UUID    `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	RequesterID uuid.UUID    `json:"requester_id"`
	AddresseeID uuid.UUID    `json:"addressee_id"`
	Status      FriendStatus `json:"status"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

// FriendView is the public projection of a user — never exposes email.
type FriendView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
}

// RequestView is a pending request plus the other user involved.
type RequestView struct {
	ID   uuid.UUID  `json:"id"`
	User FriendView `json:"user"`
}
