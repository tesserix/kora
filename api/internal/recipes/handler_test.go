package recipes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func withUser(id uuid.UUID) gin.HandlerFunc {
	return func(c *gin.Context) { c.Set("user_id", id); c.Next() }
}

func TestListRequiresAuth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)), nil)
	r := gin.New()
	r.GET("/v1/recipes", h.List)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/recipes", nil))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestGetAnotherUsersRecipeIs404(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", owner) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	created, err := svc.Create(context.Background(), owner, SaveRecipeRequest{
		Name: "Dal", Servings: 2, Source: SourceManual,
		Ingredients: []IngredientInput{ing(f.ID.String(), 100, "100g lentils")},
	})
	require.NoError(t, err)

	h := NewHandler(svc, nil)
	r := gin.New()
	r.Use(withUser(other))
	r.GET("/v1/recipes/:id", h.Get)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/recipes/"+created.ID, nil))
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestCreateRejectsMalformedBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)), nil)
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/v1/recipes", h.Create)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/recipes", bytes.NewReader([]byte("not json"))))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestCreateReturns201WithEnvelope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE user_id = ?", userID) })

	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)), nil)
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/v1/recipes", h.Create)

	body, _ := json.Marshal(map[string]any{
		"name": "Dal", "servings": 2, "source": SourceManual,
		"ingredients": []map[string]any{{"food_item_id": f.ID.String(), "grams": 100, "raw_text": "100g lentils"}},
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/recipes", bytes.NewReader(body)))
	require.Equal(t, http.StatusCreated, w.Code)

	var out struct {
		Data RecipeView `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, "Dal", out.Data.Name)
	require.NotEmpty(t, out.Data.ID)
}

func TestParseFailureIs502WithMessage(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)

	parser := NewParser(&stubProvider{generateErr: errUpstream}, nutrition.NewRepository(db), &stubMeter{})
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)), parser)
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/v1/recipes/parse", h.Parse)

	body, _ := json.Marshal(map[string]any{"text": "2 cups rice"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/recipes/parse", bytes.NewReader(body)))
	require.Equal(t, http.StatusBadGateway, w.Code)

	var out struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, "parse_failed", out.Error)
}

// An exhausted AI budget is a 429, NOT the 502 the client turns into "couldn't
// read that — enter it manually and try again": nothing was wrong with the
// recipe and retrying cannot succeed until the month rolls over.
func TestParseOverBudgetIs429(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)

	parser := NewParser(&stubProvider{generated: "{}"}, nutrition.NewRepository(db), &stubMeter{overBudget: true})
	h := NewHandler(NewService(NewRepository(db), nutrition.NewRepository(db)), parser)
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/v1/recipes/parse", h.Parse)

	body, _ := json.Marshal(map[string]any{"text": "2 cups rice"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/recipes/parse", bytes.NewReader(body)))
	require.Equal(t, http.StatusTooManyRequests, w.Code)

	var out struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, "budget_exhausted", out.Error)
}

func TestLogReturns201WithSkipped(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	userID := seedUser(t, db)
	f := seedFood(t, db, 100)
	t.Cleanup(func() {
		db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID)
		db.Exec("DELETE FROM recipes WHERE user_id = ?", userID)
	})

	svc := NewService(NewRepository(db), nutrition.NewRepository(db)).
		WithBatchLogger(foodlog.NewService(foodlog.NewRepository(db), nutrition.NewRepository(db)))
	created, err := svc.Create(context.Background(), userID, SaveRecipeRequest{
		Name: "Curry", Servings: 1, Source: SourceManual,
		Ingredients: []IngredientInput{
			ing(f.ID.String(), 100, "100g lentils"),
			{FoodItemID: nil, RawText: "a pinch of asafoetida"},
		},
	})
	require.NoError(t, err)

	h := NewHandler(svc, nil)
	r := gin.New()
	r.Use(withUser(userID))
	r.POST("/v1/recipes/:id/log", h.Log)

	body, _ := json.Marshal(map[string]any{"servings": 1, "meal_slot": "dinner"})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/recipes/"+created.ID+"/log", bytes.NewReader(body)))
	require.Equal(t, http.StatusCreated, w.Code)

	var out struct {
		Data LogRecipeResult `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, 1, out.Data.Logged)
	require.Equal(t, []string{"a pinch of asafoetida"}, out.Data.Skipped)
}

var errUpstream = errors.New("upstream unavailable")
