package labelocr

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
)

type mealProvider struct {
	ai.Provider
	calls int
	food  string
}

func (p *mealProvider) IdentifyPhoto(context.Context, []byte, string) ([]ai.Guess, ai.Usage, error) {
	p.calls++
	return []ai.Guess{{Food: p.food, Confidence: .85}}, ai.Usage{Provider: "synthetic", Model: "synthetic-model"}, nil
}

func TestMealReviewRetainsFishCurryInsteadOfPlainFish(t *testing.T) {
	primary := &mealProvider{food: "fish"}
	review := &mealProvider{food: "fish curry"}
	decision := &photoDecision{choice: "review"}
	identifier := NewMealIdentifier(primary, review, decision, &stubBudget{within: true})
	guesses, err := identifier.IdentifyPhoto(t.Context(), uuid.New(), []byte("image"), "image/jpeg")
	require.NoError(t, err)
	require.Len(t, guesses, 1)
	require.Equal(t, "fish curry", guesses[0].Food)
	require.Equal(t, 1, decision.calls)
	require.Equal(t, 1, review.calls)
}

func TestMealDecisionFailureNeverCallsReviewer(t *testing.T) {
	primary := &mealProvider{food: "fish"}
	review := &mealProvider{food: "fish curry"}
	_, err := NewMealIdentifier(primary, review, &photoDecision{err: errors.New("unavailable")}, &stubBudget{within: true}).IdentifyPhoto(t.Context(), uuid.New(), []byte("image"), "image/jpeg")
	require.ErrorIs(t, err, ErrDecisionUnavailable)
	require.Zero(t, review.calls)
}

func TestMealSimpleFoodDoesNotSpendOnReview(t *testing.T) {
	primary := &mealProvider{food: "banana"}
	review := &mealProvider{food: "banana"}
	guesses, err := NewMealIdentifier(primary, review, &photoDecision{choice: "accept"}, &stubBudget{within: true}).IdentifyPhoto(t.Context(), uuid.New(), []byte("image"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "banana", guesses[0].Food)
	require.Zero(t, review.calls)
}

type timedMealProvider struct {
	mealProvider
	delay time.Duration
}

func (p *timedMealProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	select {
	case <-ctx.Done():
		return nil, ai.Usage{Model: "synthetic-model"}, ctx.Err()
	case <-time.After(p.delay):
		return p.mealProvider.IdentifyPhoto(ctx, image, mime)
	}
}

func TestMealModelDeadlinesStopFurtherPaidWork(t *testing.T) {
	for _, tc := range []struct {
		name            string
		primary, review time.Duration
		wantElapsed     time.Duration
		primarySuccess  int
	}{
		{"primary exceeds budget", 26 * time.Second, time.Second, 25 * time.Second, 0},
		{"review exceeds budget", time.Second, 16 * time.Second, 16 * time.Second, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				primary := &timedMealProvider{mealProvider: mealProvider{food: "Chicken salad"}, delay: tc.primary}
				review := &timedMealProvider{mealProvider: mealProvider{food: "Chicken salad"}, delay: tc.review}
				decision := &photoDecision{choice: "review"}
				started := time.Now()
				_, err := NewMealIdentifier(primary, review, decision, &stubBudget{within: true}).IdentifyPhoto(t.Context(), uuid.New(), []byte("image"), "image/jpeg")
				require.ErrorIs(t, err, context.DeadlineExceeded)
				require.Equal(t, tc.wantElapsed, time.Since(started))
				require.Equal(t, tc.primarySuccess, primary.calls)
				require.Equal(t, tc.primarySuccess, decision.calls)
				require.Zero(t, review.calls)
			})
		})
	}
}
