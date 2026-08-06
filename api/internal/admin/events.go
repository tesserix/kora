package admin

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Actor identifies who performed a mutation. It is built by the CALLER from
// the BFF-verified identity on the Gin context (Task 5's job) and must never
// be constructed from anything in the request body — recordEvent trusts it
// completely and writes it straight into kora_admin_events.actor_id /
// actor_email.
type Actor struct {
	ID    string
	Email string
}

// Mutation actions recorded in kora_admin_events.action. Kept as constants so
// a typo can't silently create a new, unqueryable action string.
const (
	ActionFoodCreated = "food.created"
	ActionFoodUpdated = "food.updated"
	ActionFoodDeleted = "food.deleted"
)

// TargetTypeFood is the kora_admin_events.target_type value for every
// mutation in this file. It is its own constant (rather than inlined at each
// call site) because a future admin surface (AI key management, per the
// slice-1 designs) will add other target types, and a portal query filtering
// on target_type must match this exactly.
const TargetTypeFood = "food_item"

// AdminEvent is the Go-side shape of kora_admin_events (migration 000023).
// actor_id/actor_email are attribution columns, kept separate from
// before/after: the snapshots below describe the MUTATED ROW, never the
// actor, so a reviewer scanning `after` for what changed never has to
// mentally subtract "and also whoever did it".
type AdminEvent struct {
	ID         uuid.UUID       `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	ActorID    string          `gorm:"column:actor_id" json:"actor_id"`
	ActorEmail string          `gorm:"column:actor_email" json:"actor_email"`
	Action     string          `json:"action"`
	TargetType string          `gorm:"column:target_type" json:"target_type"`
	TargetID   *uuid.UUID      `gorm:"column:target_id" json:"target_id,omitempty"`
	Before     json.RawMessage `gorm:"column:before;type:jsonb" json:"before,omitempty"`
	After      json.RawMessage `gorm:"column:after;type:jsonb" json:"after,omitempty"`
	CreatedAt  time.Time       `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

func (AdminEvent) TableName() string { return "kora_admin_events" }

// recordEvent inserts one audit row on tx — the SAME *gorm.DB the mutation
// itself is running on, never a fresh session — so that when the caller's
// transaction (see mutations.go) commits or rolls back, the audit row goes
// with it atomically. This is the entire point of invariant 1 in the task
// brief: an audit row can never exist for a mutation that didn't happen, and
// a mutation can never commit without a matching audit row.
//
// before/after are marshalled to jsonb as given; passing a typed struct (not
// nutrition.FoodItem, which is deliberately missing deleted_at/updated_at/
// embedding — see foodSnapshot in mutations.go) is the caller's
// responsibility, not this function's.
func recordEvent(tx *gorm.DB, actor Actor, action, targetType string, targetID uuid.UUID, before, after any) error {
	beforeJSON, err := marshalSnapshot(before)
	if err != nil {
		return fmt.Errorf("admin: marshal before snapshot: %w", err)
	}
	afterJSON, err := marshalSnapshot(after)
	if err != nil {
		return fmt.Errorf("admin: marshal after snapshot: %w", err)
	}

	id := targetID
	event := AdminEvent{
		ActorID:    actor.ID,
		ActorEmail: actor.Email,
		Action:     action,
		TargetType: targetType,
		TargetID:   &id,
		Before:     beforeJSON,
		After:      afterJSON,
	}
	// actor_email carries `CHECK (btrim(actor_email) <> '')` (migration
	// 000023). A blank/whitespace Actor.Email is NOT validated here in Go —
	// it is deliberately left to fail this INSERT and roll back the
	// transaction, exactly the backstop the migration's comment describes.
	// Do not add a Go-side guard that would short-circuit before this
	// statement runs; that would remove the DB's ability to prove atomicity
	// (see mutations_test.go's TestCreateFoodAuditFailureRollsBackMutation,
	// TestUpdateFoodAuditFailureRollsBackMutation and
	// TestSoftDeleteFoodAuditFailureRollsBackMutation, all of which force
	// this exact failure).
	if err := tx.Create(&event).Error; err != nil {
		return fmt.Errorf("admin: record event: %w", err)
	}
	return nil
}

// marshalSnapshot serialises v to jsonb, or returns a nil RawMessage (SQL
// NULL) for a nil v — CreateFood has no "before" state, so it must be able to
// write a real NULL rather than the JSON literal "null".
func marshalSnapshot(v any) (json.RawMessage, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}
