// Package groups owns the group membership graph.
package groups

import (
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleOwner  Role = "owner"
	RoleMember Role = "member"
)

type Group struct {
	ID         uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name       string    `json:"name"`
	OwnerID    uuid.UUID `json:"owner_id"`
	InviteCode string    `json:"invite_code"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type GroupMember struct {
	GroupID  uuid.UUID `gorm:"primaryKey" json:"group_id"`
	UserID   uuid.UUID `gorm:"primaryKey" json:"user_id"`
	Role     Role      `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

type GroupSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	MemberCount int       `json:"member_count"`
	Role        Role      `json:"role"`
}

type MemberView struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"display_name"`
	Role        Role      `json:"role"`
}

// MemberProgressRow feeds the group leaderboard (mapped to compare.Member in the handler).
type MemberProgressRow struct {
	ID            uuid.UUID
	DisplayName   string
	ShareProgress bool
	TargetKcal    float64
}
