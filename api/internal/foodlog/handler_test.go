package foodlog

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/user"
)

func TestCreateAndListLog(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)

	// Seed a user with a known firebase uid and a food item.
	fuid := "handler-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "h@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	item := nutrition.FoodItem{Name: "Handler Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	h := NewHandler(NewService(repo, nutrition.NewRepository(db)), repo)

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Next() })
	r.Use(user.ResolveMiddleware(uRepo))
	r.POST("/v1/logs", h.Create)
	r.GET("/v1/logs", h.List)

	body, _ := json.Marshal(LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 150, LoggedAt: time.Now()})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	// The seeded user has no explicit timezone, so it provisions with
	// user.DefaultTimezone (Australia/Sydney) — compute "today" in that zone
	// to match the day-bucketing the handler actually applies.
	loc, err := time.LoadLocation(user.DefaultTimezone)
	require.NoError(t, err)
	today := time.Now().In(loc).Format("2006-01-02")
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodGet, "/v1/logs?date="+today, nil)
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusOK, w2.Code)
	require.Contains(t, w2.Body.String(), `"meal_slot":"lunch"`)
}

func TestUpdateHandler(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)

	fuid := "update-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "u@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	otherFuid := "update-other-" + uuid.NewString()
	otherU, err := uRepo.UpsertByFirebaseUID(context.Background(), otherFuid, "other@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", otherU.ID) })

	item := nutrition.FoodItem{Name: "Update Handler Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))
	h := NewHandler(svc, repo)

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", u.ID); c.Next() })
	r.PATCH("/v1/logs/:id", h.Update)

	created, err := svc.LogFood(context.Background(), u.ID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now()})
	require.NoError(t, err)

	t.Run("200 on valid grams edit with recomputed kcal", func(t *testing.T) {
		body, _ := json.Marshal(EditRequest{QuantityGrams: floatPtr(200)})
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPatch, "/v1/logs/"+created.ID.String(), bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
		require.Contains(t, w.Body.String(), `"kcal":200`)
	})

	t.Run("400 on invalid meal slot", func(t *testing.T) {
		body, _ := json.Marshal(EditRequest{MealSlot: "brunch"})
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPatch, "/v1/logs/"+created.ID.String(), bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("404 on unknown log id", func(t *testing.T) {
		body, _ := json.Marshal(EditRequest{QuantityGrams: floatPtr(50)})
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPatch, "/v1/logs/"+uuid.NewString(), bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusNotFound, w.Code)
	})

	t.Run("404 on other user's log", func(t *testing.T) {
		otherRepo := NewRepository(db)
		otherSvc := NewService(otherRepo, nutrition.NewRepository(db))
		otherLog, err := otherSvc.LogFood(context.Background(), otherU.ID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now()})
		require.NoError(t, err)

		body, _ := json.Marshal(EditRequest{QuantityGrams: floatPtr(50)})
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPatch, "/v1/logs/"+otherLog.ID.String(), bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusNotFound, w.Code)
	})

	t.Run("400 on bad id", func(t *testing.T) {
		body, _ := json.Marshal(EditRequest{QuantityGrams: floatPtr(50)})
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPatch, "/v1/logs/not-a-uuid", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})
}

func floatPtr(f float64) *float64 { return &f }

func TestRepeatWithEmptyBodyDefaultsToNow(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)
	fuid := "repeat-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "r@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	item := nutrition.FoodItem{Name: "Repeat Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	svc := NewService(repo, nutrition.NewRepository(db))
	first, err := svc.LogFood(context.Background(), u.ID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now()})
	require.NoError(t, err)

	h := NewHandler(svc, repo)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Set("user_id", u.ID); c.Next() })
	r.POST("/v1/logs/:id/repeat", h.Repeat)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/logs/"+first.ID.String()+"/repeat", nil)
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}
