package foodlog

import (
	"bytes"
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
	"gorm.io/gorm"

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

func TestCreateBatchHandler(t *testing.T) {
	db := testDB(t)
	gin.SetMode(gin.TestMode)

	fuid := "batch-" + uuid.NewString()
	uRepo := user.NewRepository(db)
	u, err := uRepo.UpsertByFirebaseUID(context.Background(), fuid, "batch@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", u.ID) })

	item := nutrition.FoodItem{Name: "Batch Handler Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	repo := NewRepository(db)
	h := NewHandler(NewService(repo, nutrition.NewRepository(db)), repo)

	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("uid", fuid); c.Next() })
	r.Use(user.ResolveMiddleware(uRepo))
	r.POST("/v1/logs/batch", h.CreateBatch)

	body, _ := json.Marshal(CreateBatchRequest{
		MealSlot: "breakfast", LoggedAt: time.Now(),
		Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 200}},
	})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/logs/batch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
	require.Contains(t, w.Body.String(), `"kcal":200`) // server-computed: 100 kcal/100g * 200g
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

// newAuthedRouter builds a router with the /v1/logs routes under test, with
// userID already in the Gin context the way user.IDFromContext reads it —
// the same inline pattern the older tests in this file use, factored out.
func newAuthedRouter(t *testing.T, db *gorm.DB, userID uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := NewRepository(db)
	h := NewHandler(NewService(repo, nutrition.NewRepository(db)), repo)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", userID); c.Next() })
	r.GET("/v1/logs/:id", h.Get)
	r.PATCH("/v1/logs/:id", h.Update)
	return r
}

func TestGetLogReturnsFullRecordIncludingInputPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Get Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	phrase := "get me " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, item, phrase)

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/logs/"+log.ID.String(), nil))

	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			ID          string  `json:"id"`
			FoodItemID  *string `json:"food_item_id"`
			InputPhrase *string `json:"input_phrase"`
			Source      string  `json:"source"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, log.ID.String(), body.Data.ID)
	require.NotNil(t, body.Data.FoodItemID, "the correction sheet needs food_item_id")
	require.NotNil(t, body.Data.InputPhrase)
	require.Equal(t, phrase, *body.Data.InputPhrase)
	require.Equal(t, "ai_text", body.Data.Source)
}

func TestGetLogIsNotFoundForAnotherUsersLog(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	stranger := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Get Food O " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	log := seedPhraseLog(t, db, owner, item, "private "+uuid.NewString())

	r := newAuthedRouter(t, db, stranger)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/logs/"+log.ID.String(), nil))

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestPatchLogReportsAliasRecordedInMeta(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	rice := nutrition.FoodItem{Name: "Rice M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	log := seedPhraseLog(t, db, userID, rice, "meta phrase "+uuid.NewString())

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	body := `{"food_item_id":"` + quinoa.ID.String() + `"}`
	req := httptest.NewRequest(http.MethodPatch, "/v1/logs/"+log.ID.String(), strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var parsed struct {
		Data struct {
			FoodItemID string `json:"food_item_id"`
		} `json:"data"`
		Meta struct {
			AliasRecorded bool `json:"alias_recorded"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))
	require.Equal(t, quinoa.ID.String(), parsed.Data.FoodItemID)
	require.True(t, parsed.Meta.AliasRecorded)
}

func TestPatchLogReportsNoAliasForPortionOnlyEdit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	rice := nutrition.FoodItem{Name: "Rice MP " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	require.NoError(t, db.Create(&rice).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", rice.ID) })

	log := seedPhraseLog(t, db, userID, rice, "meta portion "+uuid.NewString())

	r := newAuthedRouter(t, db, userID)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/logs/"+log.ID.String(),
		strings.NewReader(`{"quantity_grams":250}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	// Assert the "meta" key and "alias_recorded" key are actually PRESENT in
	// the response, not merely absent-and-defaulted-to-false: unmarshaling
	// into a struct would leave AliasRecorded as its zero value (false) even
	// if the "meta" object were dropped from the envelope entirely, which
	// would make that assertion pass vacuously.
	var envelope map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &envelope))
	metaRaw, ok := envelope["meta"]
	require.True(t, ok, "response envelope must contain a \"meta\" key")

	var meta map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(metaRaw, &meta))
	aliasRaw, ok := meta["alias_recorded"]
	require.True(t, ok, "meta must contain an \"alias_recorded\" key")

	var aliasRecorded bool
	require.NoError(t, json.Unmarshal(aliasRaw, &aliasRecorded))
	require.False(t, aliasRecorded)

	// Keep the original struct-based assertion too.
	var parsed struct {
		Meta struct {
			AliasRecorded bool `json:"alias_recorded"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &parsed))
	require.False(t, parsed.Meta.AliasRecorded)
}
