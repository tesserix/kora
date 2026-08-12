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
// derived-date assertions (e.g. target_date) are deterministic. It is UTC
// midnight, which in the Australia/Sydney default timezone (AEST, UTC+10 in
// August) is already mid-morning on the same calendar day.
func referenceNow(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
}

// submitOnboardingAt posts body to a freshly provisioned user via a Handler
// wired to a fixed clock returning now, and returns the saved user.User row.
func submitOnboardingAt(t *testing.T, body string, now time.Time) user.User {
	t.Helper()
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	userRepo := user.NewRepository(db)
	_, err := userRepo.UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := Handler{users: userRepo, now: func() time.Time { return now }}
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

// submitOnboarding is submitOnboardingAt wired to referenceNow.
func submitOnboarding(t *testing.T, body string) user.User {
	t.Helper()
	return submitOnboardingAt(t, body, referenceNow(t))
}

func TestSubmitPersistsDestination(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss",` +
		`"goal_weight_kg":78,"pace_kg_per_week":0.5}`

	saved := submitOnboarding(t, body) // returns the user.User the handler saved

	require.Equal(t, 78.0, saved.GoalWeightKg)
	require.Equal(t, 0.5, saved.PaceKgPerWeek)
	require.NotNil(t, saved.TargetDate)
	// No timezone was posted, so the handler falls back to the
	// Australia/Sydney default. referenceNow is 2026-08-12T00:00:00Z, which
	// is already 2026-08-12 in Sydney (AEST, UTC+10 in August); 6kg at
	// 0.5kg/week is 12 weeks, so the destination calendar day is 2026-11-04.
	require.Equal(t, "2026-11-04", saved.TargetDate.Format("2006-01-02"))
}

func TestSubmitAcceptsMaintenanceWithoutDestination(t *testing.T) {
	body := `{"sex":"female","birth_year":2000,"height_cm":165,"weight_kg":65,` +
		`"activity_level":"light","goal":"maintenance"}`

	saved := submitOnboarding(t, body)

	require.Equal(t, 0.0, saved.GoalWeightKg)
	require.Nil(t, saved.TargetDate)
}

func TestSubmitTargetDateUsesUsersTimezoneNotServerUTC(t *testing.T) {
	// 2026-08-11T15:00:00Z is 2026-08-12T01:00:00+10:00 in Sydney: already
	// the next calendar day locally while still the previous day in UTC.
	clock := time.Date(2026, 8, 11, 15, 0, 0, 0, time.UTC)
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss","timezone":"Australia/Sydney",` +
		`"goal_weight_kg":78,"pace_kg_per_week":0.5}`

	saved := submitOnboardingAt(t, body, clock)

	require.NotNil(t, saved.TargetDate)
	// 6kg at 0.5kg/week is 12 weeks (84 days) from the Sydney calendar day
	// 2026-08-12 -- not from 2026-08-11, which is what a naive UTC
	// calculation would have used.
	require.Equal(t, "2026-11-04", saved.TargetDate.Format("2006-01-02"))
}

func TestSubmitFatLossWithGoalWeightButNoPaceStoresNoDestination(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss","goal_weight_kg":78}`

	saved := submitOnboarding(t, body)

	require.Equal(t, 0.0, saved.GoalWeightKg)
	require.Equal(t, 0.0, saved.PaceKgPerWeek)
	require.Nil(t, saved.TargetDate)
}

func TestSubmitPersistsDestinationForMuscleGain(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":70,` +
		`"activity_level":"moderate","goal":"muscle_gain",` +
		`"goal_weight_kg":76,"pace_kg_per_week":0.5}`

	saved := submitOnboarding(t, body)

	require.Equal(t, 76.0, saved.GoalWeightKg)
	require.Equal(t, 0.5, saved.PaceKgPerWeek)
	require.NotNil(t, saved.TargetDate)
	// 6kg at 0.5kg/week is 12 weeks — same arithmetic as the fat-loss
	// direction, just gaining rather than losing.
	require.Equal(t, "2026-11-04", saved.TargetDate.Format("2006-01-02"))
}

func TestSubmitIgnoresClientSuppliedTargetDate(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":178,"weight_kg":84,` +
		`"activity_level":"moderate","goal":"fat_loss",` +
		`"goal_weight_kg":78,"pace_kg_per_week":0.5,"target_date":"2020-01-01"}`

	saved := submitOnboarding(t, body)

	require.NotNil(t, saved.TargetDate)
	require.NotEqual(t, "2020-01-01", saved.TargetDate.Format("2006-01-02"))
	require.Equal(t, "2026-11-04", saved.TargetDate.Format("2006-01-02"))
}
