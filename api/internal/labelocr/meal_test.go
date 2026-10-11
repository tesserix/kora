package labelocr

import (
	"context"
	"errors"
	"testing"

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
