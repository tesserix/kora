package resolve

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/decide"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/capturemedia"
	"github.com/tesserix/kora/api/internal/labelocr"
	"github.com/tesserix/kora/api/internal/nutrition"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type pipelineOCR struct{ image []byte }

func (o *pipelineOCR) Read(ctx context.Context, image []byte, _ string) (labelocr.Read, error) {
	o.image = bytes.Clone(image)
	select {
	case <-ctx.Done():
		return labelocr.Read{}, ctx.Err()
	case <-time.After(8 * time.Second):
		return labelocr.Read{JobID: "synthetic-native-job", Status: "review_required"}, nil
	}
}

type pipelineProvider struct {
	ai.Provider
	delay time.Duration
	model string
	image []byte
	calls int
}

func (p *pipelineProvider) IdentifyPhoto(ctx context.Context, image []byte, _ string) ([]ai.Guess, ai.Usage, error) {
	p.calls++
	p.image = bytes.Clone(image)
	u := ai.Usage{Provider: "synthetic", Model: p.model}
	select {
	case <-ctx.Done():
		return nil, u, ctx.Err()
	case <-time.After(p.delay):
		return []ai.Guess{{Food: "Chicken salad", Confidence: .95}}, u, nil
	}
}

func (*pipelineProvider) Embed(context.Context, string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{Provider: "synthetic", Model: "synthetic-embedding", CallType: "embedding"}, nil
}

type pipelineDecisions struct{ calls int }

func (d *pipelineDecisions) Decide(ctx context.Context, _ json.RawMessage, _ map[string]decide.Question) (decide.Result, error) {
	d.calls++
	choice := "vision"
	if d.calls == 2 {
		choice = "review"
	}
	select {
	case <-ctx.Done():
		return decide.Result{}, ctx.Err()
	case <-time.After(time.Second):
		return decide.Result{Model: "jev-1.13.0", Answers: map[string]decide.Answer{"route": {Choice: choice}}}, nil
	}
}

type pipelineObjects struct{ image []byte }

func (o *pipelineObjects) Put(_ context.Context, _ string, image []byte) error {
	o.image = bytes.Clone(image)
	return nil
}
func (*pipelineObjects) Delete(context.Context, string) error { return nil }

func TestPhotoAPICompletesOCRJevVertexReviewAndNutritionBeyondFormerBudgets(t *testing.T) {
	require.NotEmpty(t, os.Getenv("TEST_DATABASE_URL"))
	db, err := gorm.Open(postgres.Open(os.Getenv("TEST_DATABASE_URL")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	owner := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO users(id,idp_subject,email) VALUES (?,?,?)", owner, "pipeline-"+owner.String(), owner.String()+"@test.invalid").Error)
	repo := nutrition.NewRepository(db)
	brand := "pipeline-" + uuid.NewString()
	_, err = repo.Insert(t.Context(), []nutrition.FoodItem{{Name: "Chicken salad", Brand: brand, Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 150, ServingGrams: 100}})
	require.NoError(t, err)
	var item nutrition.FoodItem
	require.NoError(t, db.Where("brand = ?", brand).Take(&item).Error)
	require.NoError(t, repo.AddAlias(t.Context(), owner, "Chicken salad", item.ID))
	t.Cleanup(func() {
		require.NoError(t, db.Exec("DELETE FROM ai_usage_events WHERE user_id = ?", owner).Error)
		require.NoError(t, db.Exec("DELETE FROM users WHERE id = ?", owner).Error)
		require.NoError(t, db.Exec("DELETE FROM photo_object_deletions WHERE object_key LIKE ?", "captures/"+owner.String()+"/%").Error)
		require.NoError(t, db.Exec("DELETE FROM food_items WHERE id = ?", item.ID).Error)
	})
	synctest.Test(t, func(t *testing.T) {
		meter := billing.NewMeter(db)
		primary := &pipelineProvider{delay: 14 * time.Second, model: "gemini-3.5-flash"}
		review := &pipelineProvider{delay: 12 * time.Second, model: "claude-sonnet-5-5"}
		decisions := &pipelineDecisions{}
		reader := &pipelineOCR{}
		objects := &pipelineObjects{}
		resolver := ai.NewResolver(primary, repo, ai.NoCache{}, meter).WithPhotoIdentifier(labelocr.NewMealIdentifier(primary, review, decisions, meter))
		handler := NewHandler(resolver, nil).WithPhotoEvidence(reader, decisions, nil, meter).WithPhotoArchive(capturemedia.New(db, objects))
		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.Use(func(c *gin.Context) {
			c.Set("user_id", owner)
			c.Request = c.Request.WithContext(auth.WithVerifiedToken(c.Request.Context(), "isolated-test-token"))
		})
		router.POST("/v1/resolve/photo", handler.ResolvePhoto)
		var photo bytes.Buffer
		require.NoError(t, jpeg.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil))
		body, contentType := buildMultipart(t, "file", "synthetic-meal.jpg", "image/jpeg", photo.Bytes())
		request := httptest.NewRequest(http.MethodPost, "/v1/resolve/photo", body).WithContext(t.Context())
		request.Header.Set("Content-Type", contentType)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var result struct {
			Data ai.Resolution `json:"data"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
		require.Equal(t, "vision", result.Data.PhotoEvidence.Route)
		require.Equal(t, "review", result.Data.PhotoEvidence.MealReviewStatus)
		require.Equal(t, "claude-sonnet-5-5", result.Data.PhotoEvidence.MealReviewModel)
		require.Equal(t, "synthetic-native-job", result.Data.PhotoEvidence.OCRJobID)
		require.Equal(t, 2, decisions.calls)
		require.Equal(t, 1, primary.calls)
		require.Equal(t, 1, review.calls)
		require.Equal(t, objects.image, reader.image)
		require.Equal(t, objects.image, primary.image)
		require.Equal(t, objects.image, review.image)
		require.Len(t, result.Data.Candidates, 1)
		require.Equal(t, item.ID, result.Data.Candidates[0].Item.ID)
		require.True(t, result.Data.Candidates[0].PortionAssumed)
		require.Equal(t, ai.TierConfirm, result.Data.Tier)
		require.False(t, result.Data.PhotoEvidence.ConsumedAmountKnown)
		var captures, diary int64
		require.NoError(t, db.Table("photo_captures").Where("user_id = ? AND analysis_status = 'completed'", owner).Count(&captures).Error)
		require.EqualValues(t, 1, captures)
		require.NoError(t, db.Table("food_logs").Where("user_id = ?", owner).Count(&diary).Error)
		require.Zero(t, diary)
	})
}
