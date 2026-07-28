package pins

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
	"github.com/tesserix/kora/api/internal/user"
)

// withUser installs a middleware that sets the resolved user id, mimicking
// user.ResolveMiddleware, so handlers can read it via user.IDFromContext.
func withUser(id uuid.UUID) gin.HandlerFunc {
	return func(c *gin.Context) { c.Set("user_id", id); c.Next() }
}

func TestHandlerCreateListDelete(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })

	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.GET("/pins", h.List)
	r.POST("/pins", h.Create)
	r.DELETE("/pins/:foodItemId", h.Delete)

	// Create
	body, _ := json.Marshal(CreatePinRequest{FoodItemID: food.ID.String(), Grams: 100, MealSlot: "lunch"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/pins", bytes.NewReader(body)))
	require.Equal(t, http.StatusCreated, w.Code)

	// List
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/pins", nil))
	require.Equal(t, http.StatusOK, w.Code)
	var listBody struct{ Data []PinnedFood `json:"data"` }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listBody))
	require.Len(t, listBody.Data, 1)
	require.Equal(t, food.Name, listBody.Data[0].Name)

	// Delete (by food_item_id)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/pins/"+food.ID.String(), nil))
	require.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/pins", nil))
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listBody))
	require.Empty(t, listBody.Data)
}

func TestHandlerRejectsBadBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)))
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/pins", h.Create)

	body, _ := json.Marshal(CreatePinRequest{FoodItemID: uuid.NewString(), Grams: 0, MealSlot: "lunch"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/pins", bytes.NewReader(body)))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

var _ = user.IDFromContext // keep the import even if the middleware key changes
