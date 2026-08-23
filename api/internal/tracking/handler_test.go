package tracking

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
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

	body := `{"weight_kg":70.2,"body_fat_pct":32.6,"visceral_fat_rating":7.5,` +
		`"skeletal_muscle_pct":25.7,"scale_bmr_kcal":1423,"source":"scale_screenshot"}`
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

	// Unmeasured metrics are absent from the payload, not zero.
	_, present := resp.Data["muscle_mass_kg"]
	require.False(t, present, "an unmeasured metric must not be serialised at all")

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
