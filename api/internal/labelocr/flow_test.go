package labelocr_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/labelocr"
)

type flowBudget struct{ usage []ai.Usage }

func (*flowBudget) WithinBudget(context.Context, uuid.UUID) (bool, error) { return true, nil }
func (b *flowBudget) Record(_ context.Context, _ uuid.UUID, usage ai.Usage, _ float64) error {
	b.usage = append(b.usage, usage)
	return nil
}

func TestLabelUploadThroughNativeOCRAndIndependentKilojouleReview(t *testing.T) {
	var photo bytes.Buffer
	require.NoError(t, jpeg.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil))
	var upstream *httptest.Server
	var uploaded []byte
	upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var reply any
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/ocr/uploads":
			require.NotEmpty(t, r.Header.Get("X-OCR-Signature"))
			reply = map[string]any{"upload_id": "upl_synthetic", "upload_url": upstream.URL + "/storage", "required_headers": map[string]string{"Content-Type": "image/jpeg"}}
		case "GET /v1/ocr/uploads/upl_synthetic":
			status := "reserved"
			if len(uploaded) > 0 {
				status = "accepted"
			}
			reply = map[string]string{"status": status}
		case "PUT /storage":
			var err error
			uploaded, err = io.ReadAll(r.Body)
			require.NoError(t, err)
			return
		case "POST /v1/ocr/uploads/upl_synthetic/complete":
			reply = map[string]string{"status": "accepted"}
		case "POST /v1/ocr/jobs":
			reply = map[string]string{"job_id": "job_synthetic", "status": "review_required"}
		case "GET /v1/ocr/jobs/job_synthetic":
			reply = map[string]string{"status": "review_required"}
		case "GET /v1/ocr/jobs/job_synthetic/result":
			reply = map[string]any{"fields": map[string]any{}, "validation_failures": []any{}}
		default:
			http.NotFound(w, r)
			return
		}
		require.NoError(t, json.NewEncoder(w).Encode(reply))
	}))
	t.Cleanup(upstream.Close)
	reader, err := labelocr.NewClient(labelocr.Config{UploadURL: upstream.URL, JobURL: upstream.URL, KeyID: "synthetic-key", Tenant: "ten_synthetic", SecretHex: strings.Repeat("ab", 32)}, upstream.Client())
	require.NoError(t, err)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/chat/completions", r.URL.Path)
		require.Equal(t, "read_label_review", r.Header.Get("X-Kora-AI-Capability"))
		require.Equal(t, "Bearer synthetic-user", r.Header.Get("X-Kora-End-User-Token"))
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"model": "claude-sonnet-5-5", "choices": []any{map[string]any{"message": map[string]any{"content": `{"basis":"per_100g","energy_kcal":null,"energy_kj":1046,"protein_g":10,"fat_g":10,"carbohydrate_g":30}`}}},
		}))
	}))
	t.Cleanup(gateway.Close)
	budget := &flowBudget{}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set("user_id", uuid.New())
		c.Request = c.Request.WithContext(auth.WithVerifiedToken(c.Request.Context(), "synthetic-user"))
	})
	router.POST("/v1/resolve/label", labelocr.NewHandler(reader, budget, providers.NewLabelReviewer("synthetic-key", gateway.URL+"/v1")).Read)
	api := httptest.NewServer(router)
	t.Cleanup(api.Close)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", "label.jpg")
	require.NoError(t, err)
	_, err = part.Write(photo.Bytes())
	require.NoError(t, err)
	require.NoError(t, form.Close())
	response, err := api.Client().Post(api.URL+"/v1/resolve/label", form.FormDataContentType(), &body)
	require.NoError(t, err)
	t.Cleanup(func() { _ = response.Body.Close() })
	require.Equal(t, http.StatusOK, response.StatusCode)
	var result struct{ Data labelocr.LabelResponse }
	require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
	require.Equal(t, photo.Bytes(), uploaded)
	require.InDelta(t, 250, *result.Data.Per100.EnergyKcal, 0.001)
	require.Equal(t, "review_required", result.Data.Analysis.Status)
	require.False(t, result.Data.Analysis.ConsumedAmountKnown)
	require.Equal(t, "job_synthetic", result.Data.JobID)
	require.Len(t, budget.usage, 2)
	require.Equal(t, "read_label_review", budget.usage[1].CallType)
}
