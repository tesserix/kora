package onboarding

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

func handlerTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// withUID mimics the auth middleware by setting "uid" directly on the context.
func withUID(uid string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if uid != "" {
			c.Set("uid", uid)
		}
		c.Next()
	}
}

func TestSubmitHappyPath(t *testing.T) {
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	_, err := user.NewRepository(db).UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	userRepo := user.NewRepository(db)
	h := NewHandler(userRepo)
	r.POST("/v1/onboarding", withUID(fuid), user.ResolveMiddleware(userRepo), h.Submit)

	body, err := json.Marshal(map[string]any{
		"sex":            "male",
		"birth_year":     1995,
		"height_cm":      180,
		"weight_kg":      80,
		"activity_level": "moderate",
		"goal":           "maintenance",
	})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/onboarding", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"target_kcal"`)

	var resp struct {
		Data struct {
			TargetKcal  float64 `json:"target_kcal"`
			OnboardedAt *string `json:"onboarded_at"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.NotZero(t, resp.Data.TargetKcal)
	require.NotNil(t, resp.Data.OnboardedAt)
}

func TestSubmitInvalidEnum(t *testing.T) {
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	_, err := user.NewRepository(db).UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	userRepo := user.NewRepository(db)
	h := NewHandler(userRepo)
	r.POST("/v1/onboarding", withUID(fuid), user.ResolveMiddleware(userRepo), h.Submit)

	body, err := json.Marshal(map[string]any{
		"sex":            "male",
		"birth_year":     1995,
		"height_cm":      180,
		"weight_kg":      80,
		"activity_level": "moderate",
		"goal":           "banana",
	})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/onboarding", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), `"invalid_input"`)
}

func TestSubmitMissingUID(t *testing.T) {
	db := handlerTestDB(t)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(user.NewRepository(db))
	r.POST("/v1/onboarding", h.Submit)

	body, err := json.Marshal(map[string]any{
		"sex":            "male",
		"birth_year":     1995,
		"height_cm":      180,
		"weight_kg":      80,
		"activity_level": "moderate",
		"goal":           "maintenance",
	})
	require.NoError(t, err)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/onboarding", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusUnauthorized, w.Code)
}

// referenceNow is the fixed clock handed to the Handler under test so that
// derived-date assertions (e.g. target_date) are deterministic.
func referenceNow(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
}

// submitOnboarding posts body to a freshly provisioned user via a Handler
// wired to referenceNow, and returns the saved user.User row.
func submitOnboarding(t *testing.T, body string) user.User {
	t.Helper()
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	userRepo := user.NewRepository(db)
	_, err := userRepo.UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := Handler{users: userRepo, now: func() time.Time { return referenceNow(t) }}
	r.POST("/v1/onboarding", withUID(fuid), user.ResolveMiddleware(userRepo), h.Submit)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/onboarding", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	uid, err := userRepo.IDByFirebaseUID(t.Context(), fuid)
	require.NoError(t, err)
	saved, err := userRepo.ByID(t.Context(), uid)
	require.NoError(t, err)
	return saved
}

func TestSubmitPersistsDestination(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss",` +
		`"goal_weight_kg":78,"pace_kg_per_week":0.5}`

	saved := submitOnboarding(t, body) // returns the user.User the handler saved

	require.Equal(t, 78.0, saved.GoalWeightKg)
	require.Equal(t, 0.5, saved.PaceKgPerWeek)
	require.NotNil(t, saved.TargetDate)
	// 6kg at 0.5kg/week is 12 weeks — 84 days from the handler's clock.
	require.Equal(t, 84, int(saved.TargetDate.Sub(referenceNow(t)).Hours()/24))
}

func TestSubmitAcceptsMaintenanceWithoutDestination(t *testing.T) {
	body := `{"sex":"female","birth_year":2000,"height_cm":165,"weight_kg":65,` +
		`"activity_level":"light","goal":"maintenance"}`

	saved := submitOnboarding(t, body)

	require.Equal(t, 0.0, saved.GoalWeightKg)
	require.Nil(t, saved.TargetDate)
}
