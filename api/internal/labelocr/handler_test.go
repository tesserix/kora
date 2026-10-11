package labelocr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

type stubReader struct {
	read  Read
	err   error
	mime  string
	calls int
}

func (s *stubReader) Read(_ context.Context, _ []byte, mime string) (Read, error) {
	s.calls++
	s.mime = mime
	return s.read, s.err
}

var jpeg = append([]byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00"), bytes.Repeat([]byte{0}, 64)...)

type stubBudget struct {
	within   bool
	err      error
	recorded []ai.Usage
	costs    []float64
}

func (b *stubBudget) WithinBudget(context.Context, uuid.UUID) (bool, error) { return b.within, b.err }

func (b *stubBudget) Record(_ context.Context, _ uuid.UUID, u ai.Usage, costUSD float64) error {
	b.recorded = append(b.recorded, u)
	b.costs = append(b.costs, costUSD)
	return nil
}

func post(t *testing.T, reader Reader, body []byte, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	return postWithBudget(t, reader, &stubBudget{within: true}, body, signedIn)
}

func postWithBudget(t *testing.T, reader Reader, budget Budget, body []byte, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if signedIn {
		r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() })
	}
	r.POST("/label", NewHandler(reader, budget, nil).Read)

	var form bytes.Buffer
	w := multipart.NewWriter(&form)
	part, err := w.CreateFormFile("file", "label.jpg")
	require.NoError(t, err)
	_, _ = part.Write(body)
	require.NoError(t, w.Close())
	req := httptest.NewRequest(http.MethodPost, "/label", &form)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestHandlerReturnsTheCheckedLabel(t *testing.T) {
	raw, _ := json.Marshal(430)
	reader := &stubReader{read: Read{Fields: map[string]Field{"per_100g.energy_kcal": {Value: raw, Confidence: 0.9}}}}
	for key, field := range fields(t, map[string]any{"per_100g.protein_g": 7, "per_100g.fat_g": 10, "per_100g.carbohydrate_g": 75}) {
		reader.read.Fields[key] = field
	}

	rec := post(t, reader, jpeg, true)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "image/jpeg", reader.mime, "type comes from the bytes, not the client")
	var body struct {
		Data Label `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, BasisPer100g, body.Data.Basis)
	assert.InDelta(t, 430, *body.Data.Per100.EnergyKcal, 1e-9)
	var response struct {
		Data LabelResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Equal(t, "ready", response.Data.Analysis.Status)
	require.False(t, response.Data.Analysis.ConsumedAmountKnown)
	require.NotEmpty(t, response.Data.ImageSHA256)
}

func TestHandlerRejectsNonImagesBeforeCallingDocumentIntelligence(t *testing.T) {
	reader := &stubReader{}
	rec := post(t, reader, []byte("%PDF-1.7 not a photo"), true)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Zero(t, reader.calls)
}

func TestHandlerReportsAnUnreadableLabelAs422(t *testing.T) {
	rec := post(t, &stubReader{err: ErrUnreadable}, jpeg, true)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, rec.Body.String(), "label_unreadable")
}

func TestHandlerRequiresASignedInUser(t *testing.T) {
	reader := &stubReader{}
	rec := post(t, reader, jpeg, false)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Zero(t, reader.calls)
}

func TestHandlerSpendsNothingOnceTheAIBudgetIsExhausted(t *testing.T) {
	reader := &stubReader{}
	rec := postWithBudget(t, reader, &stubBudget{within: false}, jpeg, true)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "budget_exhausted")
	assert.Zero(t, reader.calls)
}

func TestHandlerFailsClosedWhenTheBudgetCannotBeChecked(t *testing.T) {
	reader := &stubReader{}
	rec := postWithBudget(t, reader, &stubBudget{err: errors.New("db down")}, jpeg, true)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Zero(t, reader.calls)
}

func TestHandlerChargesEveryLabelReadToTheBudget(t *testing.T) {
	raw, _ := json.Marshal(430)
	ok := &stubReader{read: Read{CostUSD: 0.0015, Fields: map[string]Field{"per_100g.energy_kcal": {Value: raw, Confidence: 0.9}}}}
	budget := &stubBudget{within: true}
	require.Equal(t, http.StatusOK, postWithBudget(t, ok, budget, jpeg, true).Code)

	require.Len(t, budget.recorded, 1)
	assert.Equal(t, "read_label", budget.recorded[0].CallType)
	assert.Equal(t, ai.OutcomeOK, budget.recorded[0].Outcome)
	assert.InDelta(t, 0.0015, budget.costs[0], 1e-12)

	failed := &stubBudget{within: true}
	postWithBudget(t, &stubReader{err: errors.New("upstream 503")}, failed, jpeg, true)
	require.Len(t, failed.recorded, 1, "a failed read still spent a quota slot")
	assert.Equal(t, ai.OutcomeError, failed.recorded[0].Outcome)
}

func TestHandlerRejectsUnknownCaloriesInsteadOfReturningAZeroCalorieFood(t *testing.T) {
	reader := &stubReader{read: Read{Fields: fields(t, map[string]any{"per_100g.energy_kcal": nil})}}
	rec := post(t, reader, jpeg, true)
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, rec.Body.String(), "label_unreadable")
}

type stubReviewer struct {
	read  Read
	err   error
	calls int
}

func (s *stubReviewer) Review(_ context.Context, _ []byte, _ string) (Read, ai.Usage, error) {
	s.calls++
	return s.read, ai.Usage{Model: "strong-vision", TokensIn: 100}, s.err
}

func TestImageOnlyAnalysisEscalatesOnceWithoutInventingConsumption(t *testing.T) {
	reader := &stubReader{err: ErrUnreadable}
	reviewer := &stubReviewer{read: Read{Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}}
	budget := &stubBudget{within: true}
	service := NewAnalyzer(reader, reviewer, budget)
	result, err := service.Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, reader.calls)
	require.Equal(t, 1, reviewer.calls)
	require.True(t, result.Analysis.Escalated)
	require.False(t, result.Analysis.ConsumedAmountKnown)
	require.Equal(t, "review_required", result.Analysis.Status)
	require.Equal(t, 200.0, *result.Per100.EnergyKcal)
	require.Len(t, budget.recorded, 2)
}

func TestImageOnlyAnalysisKeepsEscalationBoundedAndConservative(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      string
		primaryErr  error
		reviewErr   error
		reviewValue float64
		wantCalls   int
		wantError   bool
	}{
		{"clear_skips_expensive_review", "completed", nil, nil, 200, 0, false},
		{"partial_escalates_once", "partial", nil, nil, 200, 1, false},
		{"disagreement_is_not_silently_corrected", "partial", nil, nil, 300, 1, false},
		{"review_outage_preserves_readable_fields", "partial", nil, errors.New("provider down"), 0, 1, false},
		{"both_unreadable_require_better_image", "", ErrUnreadable, ErrUnreadable, 0, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader := &stubReader{read: Read{Status: tc.status, Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}, err: tc.primaryErr}
			if tc.status == "completed" {
				for key, field := range fields(t, map[string]any{"per_100g.protein_g": 5, "per_100g.fat_g": 6.7, "per_100g.carbohydrate_g": 30}) {
					reader.read.Fields[key] = field
				}
			}
			reviewer := &stubReviewer{read: Read{Fields: fields(t, map[string]any{"per_100g.energy_kcal": tc.reviewValue})}, err: tc.reviewErr}
			budget := &stubBudget{within: true}
			result, err := NewAnalyzer(reader, reviewer, budget).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
			if tc.wantError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				require.Equal(t, 200.0, *result.Per100.EnergyKcal)
				require.Equal(t, tc.wantCalls > 0, result.NeedsReview)
				if tc.name == "disagreement_is_not_silently_corrected" {
					require.Contains(t, result.Issues, "review_disagreement")
				}
			}
			require.Equal(t, tc.wantCalls, reviewer.calls)
			require.Len(t, budget.recorded, 1+tc.wantCalls)
		})
	}
}

type oneAttemptBudget struct{ stubBudget }

func (b *oneAttemptBudget) WithinBudget(context.Context, uuid.UUID) (bool, error) {
	return len(b.recorded) == 0, nil
}

type failedUsageBudget struct{ stubBudget }

func (b *failedUsageBudget) Record(_ context.Context, _ uuid.UUID, u ai.Usage, _ float64) error {
	b.recorded = append(b.recorded, u)
	return errors.New("usage persistence failed")
}

func TestImageOnlyAnalysisDoesNotEscalateWhenUsageCannotBeRecorded(t *testing.T) {
	reader := &stubReader{read: Read{Status: "partial", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}}
	reviewer := &stubReviewer{}
	budget := &failedUsageBudget{stubBudget: stubBudget{within: true}}
	result, err := NewAnalyzer(reader, reviewer, budget).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "usage_unavailable", result.Analysis.ReviewOutcome)
	require.Zero(t, reviewer.calls)
}

func TestImageOnlyAnalysisRechecksQuotaBeforeStrongerModel(t *testing.T) {
	reader := &stubReader{read: Read{Status: "partial", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}}
	reviewer := &stubReviewer{}
	budget := &oneAttemptBudget{}
	result, err := NewAnalyzer(reader, reviewer, budget).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, "budget_unavailable", result.Analysis.ReviewOutcome)
	require.Zero(t, reviewer.calls)
	require.Len(t, budget.recorded, 1)
}

func TestImageOnlyAnalysisEscalatesIncompleteNutritionEvenWithConfidentEnergy(t *testing.T) {
	reader := &stubReader{read: Read{Status: "completed", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}}
	reviewer := &stubReviewer{err: ErrUnreadable}
	result, err := NewAnalyzer(reader, reviewer, &stubBudget{within: true}).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
	require.NoError(t, err)
	require.Equal(t, 1, reviewer.calls)
	require.True(t, result.NeedsReview)
	require.Contains(t, result.Issues, "incomplete_nutrition")
}

func TestImageOnlyAnalysisDoesNotReportFormattingAsModelDisagreement(t *testing.T) {
	reader := &stubReader{read: Read{Status: "partial", Fields: fields(t, map[string]any{"per_100g.energy_kcal": 200})}}
	reviewer := &stubReviewer{read: Read{Fields: map[string]Field{"per_100g.energy_kcal": {Value: json.RawMessage(`200.0`), Confidence: 0.5}}}}
	result, err := NewAnalyzer(reader, reviewer, &stubBudget{within: true}).Analyze(t.Context(), uuid.New(), jpeg, "image/jpeg")
	require.NoError(t, err)
	require.NotContains(t, result.Issues, "review_disagreement")
	require.True(t, result.NeedsReview)
}
