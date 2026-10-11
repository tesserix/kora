package labelocr

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/decide"
)

type photoDecision struct {
	calls  int
	choice string
	err    error
}

func (d *photoDecision) Decide(context.Context, json.RawMessage, map[string]decide.Question) (decide.Result, error) {
	d.calls++
	return decide.Result{Model: "jev-1.13.0", Answers: map[string]decide.Answer{"route": {Choice: d.choice}}}, d.err
}

type photoVision struct{ calls int }

func (v *photoVision) ResolvePhoto(context.Context, uuid.UUID, []byte, string) (ai.Resolution, error) {
	v.calls++
	return ai.Resolution{Tier: ai.TierAuto, Candidates: []ai.ResolvedCandidate{{PortionGrams: 240, Tier: ai.TierAuto}}}, nil
}
func TestPhotoRequiresJevEvenForReadableLabel(t *testing.T) {
	reader := &stubReader{read: Read{Status: "completed", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 100, "per_100g.protein_g": 10, "per_100g.carbohydrate_g": 15, "per_100g.fat_g": 0})}}
	decision := &photoDecision{err: errors.New("unavailable")}
	vision := &photoVision{}
	service := NewPhotoResolver(reader, decision, nil, vision, &stubBudget{within: true})
	_, err := service.ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.ErrorIs(t, err, ErrDecisionUnavailable)
	require.Equal(t, 1, decision.calls)
	require.Zero(t, vision.calls)
}

func TestPhotoReadableLabelSkipsVisionAndPreservesUnknownConsumption(t *testing.T) {
	reader := &stubReader{read: Read{Status: "completed", JobID: "synthetic-job", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 100, "per_100g.protein_g": 10, "per_100g.carbohydrate_g": 15, "per_100g.fat_g": 0})}}
	decision := &photoDecision{choice: "label"}
	vision := &photoVision{}
	budget := &stubBudget{within: true}
	res, err := NewPhotoResolver(reader, decision, nil, vision, budget).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, decision.calls)
	require.Zero(t, vision.calls)
	require.Equal(t, ai.TierFollowUp, res.Tier)
	require.Empty(t, res.Candidates)
	require.Contains(t, res.FollowUpQuestion, "100.0 kcal per 100 g")
	require.False(t, res.PhotoEvidence.ConsumedAmountKnown)
	require.Equal(t, "synthetic-job", res.PhotoEvidence.OCRJobID)
	require.JSONEq(t, `{"basis":"per_100g","per_100":{"energy_kcal":100,"protein_g":10,"fat_g":0,"carbohydrate_g":15},"per_serving":{},"issues":[],"needs_review":false}`, string(res.PhotoEvidence.Label))
}

func TestPhotoMealPortionIsAlwaysAnEstimate(t *testing.T) {
	decision := &photoDecision{choice: "vision"}
	vision := &photoVision{}
	res, err := NewPhotoResolver(&stubReader{err: ErrUnreadable}, decision, nil, vision, &stubBudget{within: true}).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, decision.calls)
	require.Equal(t, 1, vision.calls)
	require.False(t, res.IsEstimate, "legacy clients reserve this flag for a supplied calorie range")
	require.True(t, res.Candidates[0].PortionAssumed)
	require.Equal(t, ai.TierConfirm, res.Tier)
	require.Equal(t, ai.TierConfirm, res.Candidates[0].Tier)
}

func TestPhotoJevCannotApproveMissingLabelEvidence(t *testing.T) {
	decision := &photoDecision{choice: "label"}
	vision := &photoVision{}
	res, err := NewPhotoResolver(&stubReader{err: ErrUnreadable}, decision, nil, vision, &stubBudget{within: true}).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.NoError(t, err)
	require.Empty(t, res.Candidates)
	require.Equal(t, "retake", res.PhotoEvidence.Route)
	require.Zero(t, vision.calls)
}

func TestPhotoQuotaStopsBeforeOCR(t *testing.T) {
	reader := &stubReader{}
	decision := &photoDecision{}
	vision := &photoVision{}
	_, err := NewPhotoResolver(reader, decision, nil, vision, &stubBudget{}).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.ErrorIs(t, err, ErrBudgetExhausted)
	require.Zero(t, decision.calls)
	require.Zero(t, vision.calls)
}

type photoReviewer struct {
	calls int
	read  Read
	err   error
}

func (r *photoReviewer) Review(context.Context, []byte, string) (Read, ai.Usage, error) {
	r.calls++
	return r.read, ai.Usage{Model: "synthetic-review"}, r.err
}

func TestPhotoRoutesUncertainLabelToIndependentReview(t *testing.T) {
	reader := &stubReader{read: Read{Status: "partial", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 100})}}
	reviewer := &photoReviewer{read: Read{Status: "review_required", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 100, "per_100g.protein_g": 10, "per_100g.carbohydrate_g": 15, "per_100g.fat_g": 0})}}
	decision := &photoDecision{choice: "review"}
	vision := &photoVision{}
	res, err := NewPhotoResolver(reader, decision, reviewer, vision, &stubBudget{within: true}).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, reviewer.calls)
	require.Zero(t, vision.calls)
	require.Contains(t, res.FollowUpQuestion, "unverified")
	require.Empty(t, res.Candidates)
	require.Equal(t, "partial", res.PhotoEvidence.OCRStatus)
	require.Contains(t, string(res.PhotoEvidence.OCRFields), "per_100g.energy_kcal")
}

func TestPhotoReviewDisagreementCannotBecomeCaloriesEaten(t *testing.T) {
	reader := &stubReader{read: Read{Status: "partial", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 100})}}
	reviewer := &photoReviewer{read: Read{Status: "completed", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200, "per_100g.protein_g": 20, "per_100g.carbohydrate_g": 30, "per_100g.fat_g": 0})}}
	res, err := NewPhotoResolver(reader, &photoDecision{choice: "review"}, reviewer, &photoVision{}, &stubBudget{within: true}).ResolvePhoto(t.Context(), uuid.New(), []byte("photo"), "image/jpeg")
	require.NoError(t, err)
	require.Empty(t, res.Candidates)
	require.Empty(t, res.PhotoEvidence.Label)
	require.Contains(t, res.FollowUpQuestion, "couldn't verify")
}
