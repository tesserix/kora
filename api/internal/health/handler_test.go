// api/internal/health/handler_test.go
package health

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// testRouter mounts POST /v1/health/sync behind a stand-in for
// user.ResolveMiddleware, mirroring api/internal/resolve/handler_test.go's
// newEngine. Returns the *fakeWriter backing the handler's Service so tests
// can assert on write calls.
func testRouter(t *testing.T) (*gin.Engine, *fakeWriter) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := &fakeWriter{}
	h := NewHandler(NewService(w))
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", uuid.New()); c.Next() })
	v1 := r.Group("/v1")
	v1.POST("/health/sync", h.Sync)
	return r, w
}

// testRouterWithoutUser mounts the same route WITHOUT the middleware that
// sets user_id in context, mirroring resolve/handler_test.go's
// newEngineNoUser — a request that reaches the handler without having gone
// through the auth/user-resolve chain in front of it.
func testRouterWithoutUser(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(NewService(&fakeWriter{}))
	r := gin.New()
	v1 := r.Group("/v1")
	v1.POST("/health/sync", h.Sync)
	return r
}

func TestSyncRequiresAuth(t *testing.T) {
	r := testRouterWithoutUser(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBufferString(`{"weights":[]}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestSyncReportsRejectedWithoutFailingTheBatch(t *testing.T) {
	r, writer := testRouter(t)
	body, _ := json.Marshal(SyncRequest{Weights: []WeightRecord{rec(70.4), rec(0)}})
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var got struct {
		Data SyncResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Equal(t, 1, got.Data.Accepted)
	require.Len(t, got.Data.Rejected, 1)
	require.Len(t, writer.calls, 1)
}

func TestSyncRejectsMalformedBody(t *testing.T) {
	r, _ := testRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBufferString(`not json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}
