package onboarding

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

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
	h := NewHandler(user.NewRepository(db))
	r.POST("/v1/onboarding", withUID(fuid), h.Submit)

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
	h := NewHandler(user.NewRepository(db))
	r.POST("/v1/onboarding", withUID(fuid), h.Submit)

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
