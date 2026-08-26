package resolveoutcome

import (
	"context"

	"github.com/tesserix/kora/api/internal/ai"
)

// Sink adapts this package's Repository to ai.OutcomeSink.
//
// The adapter lives HERE rather than in ai for the reason every other seam in
// this codebase does: ai declares the narrow interface it needs and knows
// nothing about the table, so the dependency points one way. ai.ResolveOutcome
// carries primitives; translating them into this package's typed Kind and Mode
// is this file's whole job, and it is the one place a string from ai becomes a
// value the CHECK constraints will accept.
type Sink struct{ repo Repository }

// NewSink builds the adapter.
func NewSink(repo Repository) Sink { return Sink{repo: repo} }

// Record implements ai.OutcomeSink. It cannot return an error, by design —
// see Repository.Record.
func (s Sink) Record(ctx context.Context, o ai.ResolveOutcome) {
	s.repo.Record(ctx, Outcome{
		UserID:         o.UserID,
		Kind:           Kind(o.Kind),
		Tier:           o.Tier,
		Mode:           Mode(o.Mode),
		Phrase:         o.Phrase,
		TopFoodItemID:  o.TopFoodItemID,
		TopScore:       o.TopScore,
		CandidateCount: o.CandidateCount,
		Status:         StatusOpen,
	})
}

var _ ai.OutcomeSink = Sink{}
