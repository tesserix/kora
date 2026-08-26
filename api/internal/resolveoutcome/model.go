// Package resolveoutcome records what happened to every food-resolution
// attempt, so "does the resolver work" is a number rather than a feeling
// (kora#459).
//
// # Why this exists
//
// The resolver already drew the distinctions that matter — internal/ai's
// resolve() logs "returning low-confidence match", "abstaining — best match
// below the floor" and "no match and nothing to decompose" as three separate
// lines, because they demand opposite responses: a floor that is too high is
// fixed by lowering it, an index gap only by adding data. But a log line
// cannot be counted, queried or triaged, and on 2026-08-16 a device test of
// "McSpicy" showed "couldn't identify that" with nothing in the logs able to
// say which of the two had produced it.
//
// This package is those lines, kept.
//
// # Every attempt, not every failure
//
// Recording only failures makes the failure COUNT available and the failure
// RATE uncomputable — the denominator is attempts, and a successful resolve
// leaves no other trace. A cache hit never reaches the provider, so
// ai_usage_events cannot supply the denominator either. kora#328's "resolution
// correct on first try for ≥90% of logs" needs both halves.
package resolveoutcome

import (
	"time"

	"github.com/google/uuid"
)

// Kind is which branch of the resolver terminated the attempt.
//
// The values mirror the code's own branches rather than a taxonomy invented
// here, so a row can be traced back to the line that produced it. See the
// migration for the full mapping.
type Kind string

const (
	// KindCache was served from the resolution cache: no provider call, no
	// index lookup.
	KindCache Kind = "cache"
	// KindAlias was a personal-alias short-circuit — a PREVIOUS correction
	// paying off. Kept distinct from KindResolved because counting these as
	// plain successes would hide the clearest evidence that corrections work.
	KindAlias Kind = "alias"
	// KindResolved matched at auto or confirm tier.
	KindResolved Kind = "resolved"
	// KindWeakMatch returned a low-confidence match rather than decomposing.
	KindWeakMatch Kind = "weak_match"
	// KindBelowFloor had candidates, all under the returnable floor: the index
	// HAS near-misses, and lowering the floor is the fix.
	KindBelowFloor Kind = "below_floor"
	// KindNoMatch had no candidate and nothing to decompose: an index GAP,
	// fixable only by adding data.
	KindNoMatch Kind = "no_match"
	// KindDecomposed estimated by summing ingredients. That estimate is
	// unscaled and can be an order of magnitude high.
	KindDecomposed Kind = "decomposed"
	// KindBudget means the user's AI budget was exhausted before any call.
	KindBudget Kind = "budget"
	// KindError means the provider call failed.
	KindError Kind = "error"
	// KindTranscriptBlank is a voice capture that transcribed to nothing — a
	// capture failure, distinct from KindError (a provider fault) and from
	// KindNoMatch (an index gap), because all three drive different fixes.
	KindTranscriptBlank Kind = "transcript_blank"
)

// AllKinds is every kind, declared once.
//
// Valid and needsHumanKinds are both derived from it rather than restating the
// list, because a kind added in two places and forgotten in a third is how a
// value ends up passing validation and never appearing in a query — silently
// wrong in exactly the aggregates this table exists to make trustworthy.
var AllKinds = []Kind{
	KindCache, KindAlias, KindResolved, KindWeakMatch, KindBelowFloor,
	KindNoMatch, KindDecomposed, KindBudget, KindError, KindTranscriptBlank,
}

// NeedsHuman reports whether this kind is work waiting on a person.
//
// Only the two index problems qualify. A weak match is a soft signal and a
// decomposition is a known-imprecise answer, but neither is something an
// operator can act on; putting them in a triage queue would bury the two that
// are actionable. The inbox and the health backlog both read this, so the
// queue and the depth can never disagree about what counts.
func (k Kind) NeedsHuman() bool {
	return k == KindBelowFloor || k == KindNoMatch
}

// Valid reports whether k is a recognised kind. Mirrors the CHECK constraint;
// a value outside the set is rejected before it reaches the database rather
// than surfacing as a constraint violation inside a resolve.
func (k Kind) Valid() bool {
	for _, known := range AllKinds {
		if k == known {
			return true
		}
	}
	return false
}

// Mode is how the user asked.
type Mode string

const (
	ModeText    Mode = "text"
	ModePhoto   Mode = "photo"
	ModeVoice   Mode = "voice"
	ModeBarcode Mode = "barcode"
)

// Valid reports whether m is a recognised mode.
func (m Mode) Valid() bool {
	return m == ModeText || m == ModePhoto || m == ModeVoice || m == ModeBarcode
}

// Status is the triage lifecycle, mirroring feedback.Status so the console's
// inbox can treat both queues identically (#432).
type Status string

const (
	StatusOpen       Status = "open"
	StatusInProgress Status = "in_progress"
	StatusResolved   Status = "resolved"
	StatusClosed     Status = "closed"
)

// Valid reports whether s is a recognised status.
func (s Status) Valid() bool {
	return s == StatusOpen || s == StatusInProgress || s == StatusResolved || s == StatusClosed
}

// OpenStatuses are the statuses meaning "still waiting on a human". Derived
// from the lifecycle rather than restated as literals, so a status added later
// cannot fall silently into or out of the queue.
var OpenStatuses = []Status{StatusOpen, StatusInProgress}

// Outcome is one resolve attempt's record.
type Outcome struct {
	ID     uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID uuid.UUID `gorm:"column:user_id;type:uuid;not null" json:"user_id"`
	Kind   Kind      `gorm:"column:kind" json:"kind"`
	// Tier is the resolver's OWN ai.Tier, never a threshold re-derived here.
	// Empty where no tier was reached (cache, budget, error).
	Tier string `gorm:"column:tier" json:"tier"`
	Mode Mode   `gorm:"column:mode" json:"mode"`
	// Phrase is what the user said. Nil for a photo, which has none — a
	// pointer so "no phrase" is distinguishable from "an empty one".
	Phrase *string `gorm:"column:phrase" json:"phrase,omitempty"`
	// TopFoodItemID and TopScore describe the best candidate the index
	// offered. Nil when there were none.
	TopFoodItemID  *uuid.UUID `gorm:"column:top_food_item_id;type:uuid" json:"top_food_item_id,omitempty"`
	TopScore       *float64   `gorm:"column:top_score" json:"top_score,omitempty"`
	CandidateCount int        `gorm:"column:candidate_count" json:"candidate_count"`
	Status         Status     `gorm:"column:status" json:"status"`
	CreatedAt      time.Time  `gorm:"column:created_at;autoCreateTime" json:"created_at"`
}

// TableName pins the table so GORM's pluraliser cannot drift off it.
func (Outcome) TableName() string { return "food_resolution_outcomes" }
