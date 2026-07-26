// Package notifications owns the in-app notification feed.
package notifications

import (
	"time"

	"github.com/google/uuid"
)

const (
	TypeFriendRequest    = "friend_request"
	TypeFriendAccept     = "friend_accept"
	TypeGroupInvite      = "group_invite"
	TypeChallengeCreated = "challenge_created"
	TypeChallengeStarted = "challenge_started"
	TypeChallengeEnded   = "challenge_ended"
	TypeChallengePassed  = "challenge_passed"
)

type Notification struct {
	ID         uuid.UUID  `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID     uuid.UUID  `json:"user_id"`
	Type       string     `json:"type"`
	ActorID    uuid.UUID  `json:"actor_id"`
	EntityID   *uuid.UUID `json:"entity_id,omitempty"`
	ReadAt     *time.Time `json:"read_at,omitempty"`
	CreatedAt  time.Time  `gorm:"autoCreateTime" json:"created_at"`
	PushSentAt *time.Time `gorm:"column:push_sent_at" json:"-"`
}

// NotificationView is a feed row with the actor's display name joined in.
type NotificationView struct {
	ID        uuid.UUID  `json:"id"`
	Type      string     `json:"type"`
	ActorID   uuid.UUID  `json:"actor_id"`
	ActorName string     `json:"actor_name"`
	EntityID  *uuid.UUID `json:"entity_id,omitempty"`
	Read      bool       `json:"read"`
	CreatedAt time.Time  `json:"created_at"`
}
