package savedmeals

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func withUser(id uuid.UUID) gin.HandlerFunc {
	return func(c *gin.Context) { c.Set("user_id", id); c.Next() }
}

func TestHandlerCRUD(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.GET("/saved-meals", h.List)
	r.POST("/saved-meals", h.Create)
	r.PUT("/saved-meals/:id", h.Update)
	r.DELETE("/saved-meals/:id", h.Delete)

	body, _ := json.Marshal(map[string]any{"name": "Bfast", "meal_slot": "breakfast", "items": []map[string]any{{"food_item_id": f1.ID.String(), "grams": 100}}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/saved-meals", bytes.NewReader(body)))
	require.Equal(t, http.StatusCreated, w.Code)
	var created struct{ Data SavedMealView `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := created.Data.ID

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/saved-meals", nil))
	require.Equal(t, http.StatusOK, w.Code)

	body, _ = json.Marshal(map[string]any{"name": "Renamed", "meal_slot": "lunch", "items": []map[string]any{{"food_item_id": f1.ID.String(), "grams": 150}}})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/saved-meals/"+id, bytes.NewReader(body)))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/saved-meals/"+id, nil))
	require.Equal(t, http.StatusOK, w.Code)
}

func TestHandlerRejectsBadBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/saved-meals", h.Create)
	body, _ := json.Marshal(map[string]any{"name": "", "meal_slot": "breakfast", "items": []any{}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/saved-meals", bytes.NewReader(body)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}
