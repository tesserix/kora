package labelocr

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
)

type slowLabelReader struct{}

func (slowLabelReader) Read(ctx context.Context, _ []byte, _ string) (Read, error) {
	select {
	case <-ctx.Done():
		return Read{}, ctx.Err()
	case <-time.After(13 * time.Second):
		return Read{Status: "review_required"}, nil
	}
}

type slowLabelReviewer struct{ read Read }

func (r slowLabelReviewer) Review(ctx context.Context, _ []byte, _ string) (Read, ai.Usage, error) {
	select {
	case <-ctx.Done():
		return Read{}, ai.Usage{}, ctx.Err()
	case <-time.After(11 * time.Second):
		return r.read, ai.Usage{Provider: "synthetic", Model: "synthetic-review"}, nil
	}
}

func TestLabelAnalysisAllowsOCRAndReviewToFinishWithinTheirBudgets(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		reviewer := slowLabelReviewer{read: Read{Status: "review_required", Fields: fields(t, map[string]any{
			"per_100g.energy_kcal": 200, "per_100g.protein_g": 5, "per_100g.fat_g": 10, "per_100g.carbohydrate_g": 22.5,
		})}}
		budget := &stubBudget{within: true}
		started := time.Now()
		result, err := NewAnalyzer(slowLabelReader{}, reviewer, budget).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
		require.NoError(t, err)
		require.Equal(t, 24*time.Second, time.Since(started))
		require.Equal(t, 200.0, *result.Per100.EnergyKcal)
		require.Equal(t, "review_required", result.Analysis.Status)
		require.Equal(t, "reviewed", result.Analysis.ReviewOutcome)
		require.False(t, result.Analysis.ConsumedAmountKnown)
		require.Len(t, budget.recorded, 2)
		require.Equal(t, ai.OutcomeOK, budget.recorded[1].Outcome)
	})
}
