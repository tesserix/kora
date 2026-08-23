package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/guardrails"
)

func weightRouter(userID uuid.UUID, repo Repository) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	h := NewHandler(repo)
	r.POST("/v1/weight", h.AddWeight)
	r.GET("/v1/weight", h.ListWeight)
	return r
}

func TestAddWeightHandler(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := weightRouter(userID, NewRepository(db))

	req := httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(`{"weight_kg":72.4}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	// non-positive weight -> 400
	req = httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(`{"weight_kg":0}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestListWeightHandlerReturnsSeries(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	r := weightRouter(userID, repo)

	base := time.Now().Add(-48 * time.Hour)
	_, _ = repo.AddWeight(context.Background(), userID, 74.0, base, dayOf(base))
	_, _ = repo.AddWeight(context.Background(), userID, 73.5, base.Add(24*time.Hour), dayOf(base.Add(24*time.Hour)))

	from := time.Now().Add(-72 * time.Hour).Format(time.RFC3339)
	to := time.Now().Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, "/v1/weight?from="+from+"&to="+to, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data []WeightEntry `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data, 2)
	require.Equal(t, 74.0, body.Data[0].WeightKg)
}

// The JSON keys the client sends must be exactly the column names, and an
// omitted metric must be omitted from the response rather than serialised as 0
// — the wire format is where "absent is not zero" either survives or is lost
// (kora#45).
func TestAddWeightHandlerAcceptsAndReturnsComposition(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := weightRouter(userID, NewRepository(db))

	// waist_cm and arm_cm only: a tape is used piecemeal, so the wire has to
	// carry a partial set without the untouched measurements becoming 0.
	body := `{"weight_kg":70.2,"body_fat_pct":32.6,"visceral_fat_rating":7.5,` +
		`"skeletal_muscle_pct":25.7,"scale_bmr_kcal":1423,` +
		`"waist_cm":80,"arm_cm":30,"source":"scale_screenshot"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	var resp struct {
		Data map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, 32.6, resp.Data["body_fat_pct"])
	require.Equal(t, 7.5, resp.Data["visceral_fat_rating"])
	require.Equal(t, 25.7, resp.Data["skeletal_muscle_pct"])
	require.Equal(t, 1423.0, resp.Data["scale_bmr_kcal"])
	require.Equal(t, "scale_screenshot", resp.Data["source"])
	require.Equal(t, 80.0, resp.Data["waist_cm"])
	require.Equal(t, 30.0, resp.Data["arm_cm"])

	// Unmeasured metrics are absent from the payload, not zero.
	_, present := resp.Data["muscle_mass_kg"]
	require.False(t, present, "an unmeasured metric must not be serialised at all")

	// The same rule for the tape measurements this caller did not take. A
	// serialised 0 here would draw a neck that shrank to nothing.
	for _, untaken := range []string{"neck_cm", "chest_cm", "hip_cm", "thigh_cm"} {
		_, present := resp.Data[untaken]
		require.False(t, present, "%s was never measured and must not be serialised", untaken)
	}

	// Derived values are never echoed back, because they are never stored.
	for _, derived := range []string{"bmi", "fat_mass_kg", "fat_free_mass_kg", "metabolic_age"} {
		_, present := resp.Data[derived]
		require.False(t, present, "%s is derived on the client, never stored", derived)
	}
}

// An impossible metric is the caller's mistake, so it must read as a 400 with a
// named field rather than a 500 from a CHECK violation.
func TestAddWeightHandlerRejectsImpossibleComposition(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := weightRouter(userID, NewRepository(db))

	for _, body := range []string{
		`{"weight_kg":70.2,"body_fat_pct":132.6}`,
		`{"weight_kg":70.2,"visceral_fat_rating":95}`,
		`{"weight_kg":70.2,"source":"renpho"}`,
		// A tape measurement typed in millimetres, and one left at 0. Both
		// must be a 400 naming the field, never a silent store.
		`{"weight_kg":70.2,"waist_cm":800}`,
		`{"weight_kg":70.2,"neck_cm":0}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/weight", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code, "body: %s", body)
	}
}

// kora#378: a weigh-in stamped later today must still appear in its own
// series. The client sends a date-only entry as midday UTC, which is in the
// future for most of the day, and ListWeight used to default `to` to
// time.Now() -- so a morning weigh-in was written correctly and then
// excluded from the very read meant to display it, with no error anywhere.
func TestListWeightHandlerIncludesEntriesStampedLaterToday(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	r := weightRouter(userID, repo)

	// Midday UTC today, exactly as BodyCompositionForm stamps a date-only
	// entry. Skipped after midday, when it is no longer a future instant and
	// so cannot exercise the bug.
	now := time.Now().UTC()
	midday := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC)
	if !midday.After(now) {
		t.Skip("past midday UTC: the future-stamp case cannot be reproduced now")
	}
	_, err := repo.AddWeight(context.Background(), userID, 74.0, midday, dayOf(midday))
	require.NoError(t, err)

	// No `to` -- the default is what decides whether today's entry is visible.
	from := now.Add(-72 * time.Hour).Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, "/v1/weight?from="+from, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data []WeightEntry `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Data, 1, "an entry stamped later today must be in its own series")
}

// fakeSignals stands in for the coach adapter. It takes loc per call because
// SignalsFor does: recentDeficitPct excludes "today" by LOCAL day, so a
// server-wide fixed zone would count the wrong days for a user outside it.
type fakeSignals struct {
	signals guardrails.Signals
	err     error
	gotLoc  *time.Location
}

func (f *fakeSignals) SignalsFor(_ context.Context, _ uuid.UUID, loc *time.Location) (guardrails.Signals, error) {
	f.gotLoc = loc
	return f.signals, f.err
}

func trendRouter(userID uuid.UUID, repo Repository, sig SignalsSource) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	h := NewHandler(repo).WithSignals(sig)
	r.GET("/v1/weight/trend", h.WeightTrend)
	return r
}

// seedDecline writes five synthetic readings a week apart, declining 0.5 a
// week. Invented figures: this repo is public and carries no real body data.
func seedDecline(t *testing.T, repo Repository, userID uuid.UUID) {
	t.Helper()
	for i, w := range []float64{80, 79.5, 79, 78.5, 78} {
		at := time.Now().AddDate(0, 0, -28+(i*7))
		_, err := repo.AddWeight(context.Background(), userID, w, at, dayOf(at))
		require.NoError(t, err)
	}
}

func TestWeightTrendReturnsARateWhenNotAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	r := trendRouter(userID, repo, &fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
			Basis       struct {
				Readings int `json:"readings"`
				Days     int `json:"days"`
			} `json:"basis"`
			ShowSupport bool `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "ok", body.Data.Status)
	require.NotNil(t, body.Data.RatePerWeek)
	require.InDelta(t, -0.5, *body.Data.RatePerWeek, 0.05)
	require.Equal(t, 5, body.Data.Basis.Readings)
	require.Equal(t, 28, body.Data.Basis.Days)
	require.False(t, body.Data.ShowSupport)
}

// The guardrail. This is the test that must go red if suppression is removed.
func TestWeightTrendSuppressesForAnAtRiskUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	atRisk := guardrails.Signals{RecentDeficitPct: 0.95, AvgIntakeKcal: 600, LogsPerDay: 1}
	require.True(t, guardrails.AtRisk(atRisk), "fixture must actually trip the policy")

	r := trendRouter(userID, repo, &fakeSignals{signals: atRisk})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
			ShowSupport bool     `json:"show_support"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "suppressed", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek, "a suppressed rate must not be on the wire at all")
	require.NotContains(t, w.Body.String(), "rate_per_week", "the key itself must not appear")
	require.True(t, body.Data.ShowSupport)
}

// Fails closed: unknown risk is not no-risk.
func TestWeightTrendSuppressesWhenSignalsAreUnavailable(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	r := trendRouter(userID, repo, &fakeSignals{err: errors.New("grounding failed")})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code, "a signals failure is not the caller's error")

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "suppressed", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek)
}

// A handler wired without a signals source cannot know the risk state, so it
// must suppress too — the same fail-closed rule as an errored lookup.
func TestWeightTrendSuppressesWithoutASignalsSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	r.GET("/v1/weight/trend", NewHandler(repo).WeightTrend)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "suppressed", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek)
}

func TestWeightTrendReportsInsufficientData(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	at := time.Now().AddDate(0, 0, -3)
	_, err := repo.AddWeight(context.Background(), userID, 80, at, dayOf(at))
	require.NoError(t, err)

	r := trendRouter(userID, repo, &fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data struct {
			Status      string   `json:"status"`
			RatePerWeek *float64 `json:"rate_per_week"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "insufficient_data", body.Data.Status)
	require.Nil(t, body.Data.RatePerWeek)
}

func TestWeightTrendRejectsAnUnknownMetric(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := trendRouter(userID, NewRepository(db), &fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=nonsense&range=3M", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// An empty metric is not a licence to guess one. The allow-list has to reject
// it explicitly, or a client bug becomes a silently-wrong figure.
func TestWeightTrendRejectsAMissingMetric(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := trendRouter(userID, NewRepository(db), &fakeSignals{})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?range=3M", nil))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// The allow-list and metricValue must never drift apart: a key accepted here
// that metricValue cannot read yields a permanent insufficient_data, and a
// key metricValue reads but the list rejects is an unreachable metric.
func TestKnownMetricAgreesWithMetricValue(t *testing.T) {
	for metric := range knownMetrics {
		_, ok := metricValue(WeightEntry{BodyComposition: BodyComposition{
			BodyFatPct: ptr(1), SubcutaneousFatPct: ptr(1), VisceralFatRating: ptr(1),
			SkeletalMusclePct: ptr(1), MuscleMassKg: ptr(1), BodyWaterPct: ptr(1),
			ProteinPct: ptr(1), BoneMassKg: ptr(1), ScaleBMRKcal: ptr(1),
			NeckCm: ptr(1), ChestCm: ptr(1), WaistCm: ptr(1),
			HipCm: ptr(1), ArmCm: ptr(1), ThighCm: ptr(1),
		}}, metric)
		require.True(t, ok, "allow-listed metric %q is not readable by metricValue", metric)
	}
}

// Range keys must match the client's WEIGHT_RANGE_DAYS; an unrecognised key
// falls back to a month rather than to zero days.
func TestRangeDays(t *testing.T) {
	require.Equal(t, 7, rangeDays("1W"))
	require.Equal(t, 30, rangeDays("1M"))
	require.Equal(t, 90, rangeDays("3M"))
	require.Equal(t, 365, rangeDays("1Y"))
	require.Equal(t, 30, rangeDays(""))
	require.Equal(t, 30, rangeDays("nonsense"))
}

// The location must come from the request, not from a value pinned at
// construction: SignalsFor's day arithmetic is local, so a server-wide zone
// would classify risk on the wrong days for a user outside it.
func TestWeightTrendPassesTheRequestLocationToSignals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	seedDecline(t, repo, userID)

	kolkata, err := time.LoadLocation("Asia/Kolkata")
	require.NoError(t, err)

	sig := &fakeSignals{}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("user_id", userID)
		c.Set("user_loc", kolkata)
		c.Next()
	})
	r.GET("/v1/weight/trend", NewHandler(repo).WithSignals(sig).WeightTrend)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/weight/trend?metric=weight_kg&range=3M", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, kolkata, sig.gotLoc)
}
