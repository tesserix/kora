// Package billing owns AI usage metering and monthly budget enforcement.
package billing

import (
	"time"

	"github.com/google/uuid"
)

// Event is one metered AI provider call, persisted for cost accounting.
type Event struct {
	ID uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	// UserID is a POINTER because the column is nullable and NULL is a value
	// this table genuinely holds. Two things write it: migration 000025 nulls
	// it when a user is deleted (the row is retained as an anonymous usage
	// counter, see #106), and Meter.RecordSystem writes it nil for calls no
	// user made — the food-index backfill in cmd/embed.
	//
	// A non-pointer uuid.UUID cannot express that: it would write the zero UUID
	// instead, which the ai_usage_events_user_id_fkey foreign key rejects
	// outright, so the row would simply never land.
	UserID     *uuid.UUID `json:"-"`
	Provider   string     `json:"provider"`
	Model      string     `json:"model"`
	CallType   string     `json:"call_type"`
	TokensIn   int        `json:"tokens_in"`
	TokensOut  int        `json:"tokens_out"`
	LatencyMs  int        `json:"latency_ms"`
	CostUSDEst float64    `gorm:"column:cost_usd_est" json:"cost_usd_est"`
	// ok | error | timeout. Failures are recorded too since #81, so any cost
	// query that does not filter this will OVER-count.
	Outcome   string    `json:"outcome"`
	CreatedAt time.Time `json:"created_at"`
}

// TableName pins the GORM table name (default pluralization would be
// "events", not "ai_usage_events").
func (Event) TableName() string {
	return "ai_usage_events"
}
