package accuracy

import (
	"context"
	"errors"
	"log/slog"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

// Outcomes loads a user's resolution outcome.
type Outcomes interface {
	Get(ctx context.Context, userID, id uuid.UUID) (resolveoutcome.Outcome, error)
}

// Recorder links food logs to the resolutions they confirm and scores them.
type Recorder struct {
	outcomes Outcomes
	scores   *Client
}

// NewRecorder scores through client, which may be nil to link logs without scoring.
func NewRecorder(outcomes Outcomes, client *Client) Recorder {
	return Recorder{outcomes: outcomes, scores: client}
}

// Owns reports whether the user's resolution exists and offered an item at index.
func (r Recorder) Owns(ctx context.Context, userID, resolutionID uuid.UUID, index int) bool {
	o, err := r.outcomes.Get(ctx, userID, resolutionID)
	if err != nil {
		if !errors.Is(err, resolveoutcome.ErrNotFound) {
			slog.WarnContext(ctx, "accuracy: resolution lookup failed", "err", err)
		}
		return false
	}
	return index >= 0 && index < len(o.CandidateFoodItemIDs)
}

// Logged scores the food the user kept against the item the resolution offered at index.
func (r Recorder) Logged(ctx context.Context, userID, resolutionID uuid.UUID, index int, foodItemID uuid.UUID, corrected bool) {
	if r.scores == nil {
		return
	}
	o, err := r.outcomes.Get(ctx, userID, resolutionID)
	if err != nil {
		slog.WarnContext(ctx, "accuracy: resolution not scored", "err", err)
		return
	}
	r.scores.Send(ctx, CaptureScores(o, index, foodItemID, corrected))
}
