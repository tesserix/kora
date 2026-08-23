package coach

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/guardrails"
)

// signalsSource adapts Grounder to the narrow interface tracking declares.
//
// It exists so that tracking never imports coach and never recomputes risk:
// SignalsFrom stays the single definition, which is what #23 was filed to
// protect. See the design doc, decision 5.
type signalsSource struct {
	grounder Grounder
	loc      *time.Location
}

// NewSignalsSource builds the coach-side implementation of
// tracking.SignalsSource.
func NewSignalsSource(g Grounder, loc *time.Location) signalsSource {
	return signalsSource{grounder: g, loc: loc}
}

// SignalsFor builds a Context for userID and derives guardrails.Signals from
// it via SignalsFrom — the single definition of risk. A BuildContext failure
// is returned to the caller as an error rather than papered over with a
// zero-value Signals: an unknown risk state must never read as "no risk".
func (s signalsSource) SignalsFor(ctx context.Context, userID uuid.UUID) (guardrails.Signals, error) {
	built, err := s.grounder.BuildContext(ctx, userID, time.Now(), s.loc)
	if err != nil {
		return guardrails.Signals{}, fmt.Errorf("coach: signals for trend: %w", err)
	}
	return SignalsFrom(built), nil
}
