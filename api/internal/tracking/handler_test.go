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
	_, _ = repo.AddWeight(context.Background(), userID, 74.0, base)
	_, _ = repo.AddWeight(context.Background(), userID, 73.5, base.Add(24*time.Hour))

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
