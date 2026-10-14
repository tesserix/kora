package resolve

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/decide"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/labelocr"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type photoTimeoutOCR struct{}

func (photoTimeoutOCR) Read(context.Context, []byte, string) (labelocr.Read, error) {
	return labelocr.Read{Status: "review_required", JobID: "synthetic-native-photo"}, nil
}

type photoTimeoutBudget struct{ records []ai.Usage }

func (*photoTimeoutBudget) WithinBudget(context.Context, uuid.UUID) (bool, error) {
	return true, nil
}
func (b *photoTimeoutBudget) Record(_ context.Context, _ uuid.UUID, usage ai.Usage, _ float64) error {
	b.records = append(b.records, usage)
	return nil
}

type photoTimeoutGateway struct {
	delay  time.Duration
	status int
}

func (g photoTimeoutGateway) RoundTrip(r *http.Request) (*http.Response, error) {
	timer := time.NewTimer(g.delay)
	defer timer.Stop()
	select {
	case <-r.Context().Done():
		return nil, r.Context().Err()
	case <-timer.C:
		return &http.Response{StatusCode: g.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"model":"jev-1.13.0","answers":{"route":{"type":"choice","choice":"vision","confidence":1,"probabilities":{"label":0,"review":0,"vision":1,"retake":0}}},"usage":{"input_tokens":10,"output_tokens":2}}`))}, nil
	}
}

func TestPhotoAPIRequiresSuccessfulDecisionWithinRemainingBudget(t *testing.T) {
	var photo bytes.Buffer
	require.NoError(t, jpeg.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil))
	for _, tc := range []struct {
		name           string
		delay          time.Duration
		upstreamStatus int
		wantStatus     int
	}{
		{"decision completes after former limit", 2 * time.Second, 200, 200},
		{"decision exceeds hard limit", 5 * time.Second, 200, 503},
		{"decision unavailable", 0, 503, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				decision, err := decide.NewClient("http://127.0.0.1", "test-key", &http.Client{Transport: photoTimeoutGateway{tc.delay, tc.upstreamStatus}})
				require.NoError(t, err)
				vision := &stubTP{photo: ai.Resolution{Tier: ai.TierAuto, Candidates: []ai.ResolvedCandidate{{Item: nutrition.FoodItem{Name: "Chicken salad"}, PortionGrams: 100, Tier: ai.TierAuto}}}}
				budget := &photoTimeoutBudget{}
				handler := NewHandler(vision, nil).WithPhotoEvidence(photoTimeoutOCR{}, decision, nil, budget)
				gin.SetMode(gin.TestMode)
				router := gin.New()
				router.Use(func(c *gin.Context) {
					c.Set("user_id", uuid.New())
					c.Request = c.Request.WithContext(auth.WithVerifiedToken(c.Request.Context(), "isolated-test-token"))
				})
				router.POST("/v1/resolve/photo", handler.ResolvePhoto)
				body, contentType := buildMultipart(t, "file", "synthetic-meal.jpg", "image/jpeg", photo.Bytes())
				request := httptest.NewRequest(http.MethodPost, "/v1/resolve/photo", body).WithContext(t.Context())
				request.Header.Set("Content-Type", contentType)
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				require.Equal(t, tc.wantStatus, response.Code, response.Body.String())
				require.Len(t, budget.records, 2)
				if tc.wantStatus != 200 {
					require.Zero(t, vision.gotSize, "failed mandatory decisions must stop food vision")
					require.Contains(t, response.Body.String(), "ai_decision_unavailable")
					return
				}
				var result struct {
					Data ai.Resolution `json:"data"`
				}
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
				require.Equal(t, "vision", result.Data.PhotoEvidence.Route)
				require.Equal(t, "review_required", result.Data.PhotoEvidence.OCRStatus)
				require.Equal(t, ai.TierConfirm, result.Data.Tier)
				require.Len(t, result.Data.Candidates, 1)
				require.True(t, result.Data.Candidates[0].PortionAssumed)
				require.False(t, result.Data.PhotoEvidence.ConsumedAmountKnown)
			})
		})
	}
}
