package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

	"github.com/tesserix/kora/api/internal/tracking"
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
	h := NewHandler(userRepo, tracking.NewRepository(db))
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
	h := NewHandler(userRepo, tracking.NewRepository(db))
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
	h := NewHandler(user.NewRepository(db), tracking.NewRepository(db))
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
	saved, _, _ := submitOnboardingWith(t, body, now, nil)
	return saved
}

// submitOnboarding is submitOnboardingAt wired to referenceNow.
func submitOnboarding(t *testing.T, body string) user.User {
	t.Helper()
	return submitOnboardingAt(t, body, referenceNow(t))
}

// submitOnboardingWith is submitOnboardingAt's full form: it exposes the db
// and provisioned user ID (for asserting on weight_entries directly) and lets
// a test override the WeightRecorder -- e.g. with one that always errors, to
// exercise the failure-isolation path. A nil weights uses a real
// tracking.Repository against the same db, exercising the real write.
func submitOnboardingWith(t *testing.T, body string, now time.Time, weights WeightRecorder) (user.User, *gorm.DB, uuid.UUID) {
	t.Helper()
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	userRepo := user.NewRepository(db)
	_, err := userRepo.UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	if weights == nil {
		weights = tracking.NewRepository(db)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := Handler{users: userRepo, weights: weights, now: func() time.Time { return now }}
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
	return saved, db, uid
}

// erroringWeightRecorder always fails, to exercise onboarding's
// failure-isolation path: a broken secondary write must not fail the request.
type erroringWeightRecorder struct{}

func (erroringWeightRecorder) AddWeightEntry(context.Context, uuid.UUID, tracking.WeightInput) (tracking.WeightEntry, error) {
	return tracking.WeightEntry{}, errors.New("boom")
}

// TestSubmitRecordsFirstWeighIn is the core kora#45 behaviour: onboarding's
// stated weight becomes a real weight_entries row, not just profile.weight_kg.
func TestSubmitRecordsFirstWeighIn(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":180,"weight_kg":80,` +
		`"activity_level":"moderate","goal":"maintenance"}`

	_, db, uid := submitOnboardingWith(t, body, referenceNow(t), nil)

	var entries []tracking.WeightEntry
	require.NoError(t, db.Where("user_id = ?", uid).Find(&entries).Error)
	require.Len(t, entries, 1, "onboarding must create exactly one weigh-in")

	e := entries[0]
	require.Equal(t, 80.0, e.WeightKg)
	require.Equal(t, tracking.SourceManual, e.Source)
	// An onboarding weight is a weight, not a body composition -- every
	// other metric must stay absent, never a measured 0. See migration
	// 000039 and internal/tracking/model.go.
	require.Nil(t, e.BodyFatPct)
	require.Nil(t, e.SubcutaneousFatPct)
	require.Nil(t, e.VisceralFatRating)
	require.Nil(t, e.SkeletalMusclePct)
	require.Nil(t, e.MuscleMassKg)
	require.Nil(t, e.BodyWaterPct)
	require.Nil(t, e.ProteinPct)
	require.Nil(t, e.BoneMassKg)
	require.Nil(t, e.ScaleBMRKcal)
}

// TestSubmitTwiceRecordsOnlyOneWeighIn is the idempotency guarantee: a
// resubmitted (or retried) onboarding call must not duplicate the first
// weigh-in. Two same-day, same-value entries would put a fake flat segment
// at the start of the user's trend.
func TestSubmitTwiceRecordsOnlyOneWeighIn(t *testing.T) {
	db := handlerTestDB(t)
	fuid := uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid) })

	userRepo := user.NewRepository(db)
	_, err := userRepo.UpsertByFirebaseUID(t.Context(), fuid, fuid+"@test.dev")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := Handler{users: userRepo, weights: tracking.NewRepository(db), now: func() time.Time { return referenceNow(t) }}
	r.POST("/v1/onboarding", withUID(fuid), user.ResolveMiddleware(userRepo), h.Submit)

	body := []byte(`{"sex":"male","birth_year":1995,"height_cm":180,"weight_kg":80,` +
		`"activity_level":"moderate","goal":"maintenance"}`)

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPost, "/v1/onboarding", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}

	uid, err := userRepo.IDByFirebaseUID(t.Context(), fuid)
	require.NoError(t, err)
	var entries []tracking.WeightEntry
	require.NoError(t, db.Where("user_id = ?", uid).Find(&entries).Error)
	require.Len(t, entries, 1, "a resubmitted onboarding must not create a second weigh-in")
}

// TestSubmitSucceedsWhenWeightWriteFails is the failure-isolation guarantee:
// a user must not be blocked from completing onboarding by a broken
// secondary write. The profile is still saved even though no weigh-in is.
func TestSubmitSucceedsWhenWeightWriteFails(t *testing.T) {
	body := `{"sex":"male","birth_year":1995,"height_cm":180,"weight_kg":80,` +
		`"activity_level":"moderate","goal":"maintenance"}`

	saved, db, uid := submitOnboardingWith(t, body, referenceNow(t), erroringWeightRecorder{})

	require.Equal(t, 80.0, saved.WeightKg)
	require.NotNil(t, saved.OnboardedAt, "onboarding must still complete")

	var count int64
	require.NoError(t, db.Model(&tracking.WeightEntry{}).Where("user_id = ?", uid).Count(&count).Error)
	require.Zero(t, count, "a failed weight write must leave no weigh-in behind")
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
