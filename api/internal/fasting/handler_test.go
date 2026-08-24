package fasting

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// fastingRouter sets the context keys user.ResolveMiddleware would set, so
// user.IDFromContext (and thus Handler.resolveUser) resolves userID exactly
// as it would behind real auth middleware.
func fastingRouter(userID uuid.UUID, repo Repository) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("user_id", userID)
		c.Set("user_loc", time.UTC)
		c.Next()
	})
	h := NewHandler(repo)
	r.POST("/v1/fasting/start", h.Start)
	r.POST("/v1/fasting/end", h.End)
	r.GET("/v1/fasting/current", h.Current)
	return r
}

func TestEndingNothingIsA200WithNoBody(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	r := fastingRouter(userID, NewRepository(db))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/fasting/end", nil))
	require.Equal(t, http.StatusOK, w.Code, "a stale screen is not an error")

	var body struct {
		Data *Interval `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Nil(t, body.Data)
}

func TestCurrentReportsTheOpenFast(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)
	r := fastingRouter(userID, repo)

	now := time.Now()
	started, err := repo.Start(context.Background(), userID, now, now)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/fasting/current", nil))
	require.Equal(t, http.StatusOK, w.Code)

	var body struct {
		Data *Interval `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotNil(t, body.Data)
	require.Equal(t, started.ID, body.Data.ID)
}

// TestStartUnauthorizedWithNoUserInContext guards resolveUser going through
// user.IDFromContext: a request with neither "user_id" nor "user_loc" set
// (i.e. auth.Middleware/user.ResolveMiddleware never ran) must 401, not
// panic on a failed type assertion and not silently proceed as uuid.Nil.
func TestStartUnauthorizedWithNoUserInContext(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(repo)
	r.POST("/v1/fasting/start", h.Start)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/fasting/start", nil))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}
