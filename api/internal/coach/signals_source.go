package coach

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/guardrails"
)

// SignalsSource adapts Grounder to the narrow interface tracking declares.
//
// It exists so that tracking never imports coach and never recomputes risk:
// SignalsFrom stays the single definition, which is what #23 was filed to
// protect. See the design doc, decision 5.
type SignalsSource struct {
	grounder Grounder
}

// NewSignalsSource builds the coach-side implementation of
// tracking.SignalsSource.
func NewSignalsSource(g Grounder) SignalsSource {
	return SignalsSource{grounder: g}
}

// SignalsFor builds a Context for userID and derives guardrails.Signals from
// it via SignalsFrom — the single definition of risk. A BuildContext failure
// is returned to the caller as an error rather than papered over with a
// zero-value Signals: an unknown risk state must never read as "no risk".
//
// loc is a per-call argument rather than a field: recentDeficitPct excludes
// "today" by LOCAL day, so a zone fixed at construction would count the
// wrong days for a user outside it.
func (s SignalsSource) SignalsFor(ctx context.Context, userID uuid.UUID, loc *time.Location) (guardrails.Signals, error) {
	built, err := s.grounder.BuildContext(ctx, userID, time.Now(), loc)
	if err != nil {
		return guardrails.Signals{}, fmt.Errorf("coach: signals for trend: %w", err)
	}
	return SignalsFrom(built), nil
}
