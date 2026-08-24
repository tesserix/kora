// api/internal/health/handler_test.go
package health

import (
	"bytes"
	"encoding/json"
	"log/slog"
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

// captureLogs redirects slog's default logger into a buffer for the duration
// of one test and restores it afterwards.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

// TestSyncLogsReceivedAndAcceptedCounts covers the instrument kora#30's
// relaunch check depends on, and the reason it has to exist is worth stating:
// the two outcomes it distinguishes are INVISIBLE in the database.
//
// The device holds an anchor in AsyncStorage. Reused, the client finds no new
// samples and posts nothing at all -- a healthy re-sync is silence. Lost, the
// client re-sends the user's whole history, and the unique index on
// (user_id, hk_uuid) absorbs every row. Same row count, same contents, either
// way. `received` is the only thing that tells them apart.
//
// So this asserts received SEPARATELY from accepted. A log line carrying only
// accepted would read 0 in both cases and answer nothing.
func TestSyncLogsReceivedAndAcceptedCounts(t *testing.T) {
	logs := captureLogs(t)
	r, _ := testRouter(t)

	// Three records, one of them invalid: received and accepted must differ,
	// so a line that conflated them cannot pass.
	body, _ := json.Marshal(SyncRequest{Weights: []WeightRecord{rec(70.4), rec(71.1), rec(0)}})
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	var line struct {
		Msg      string  `json:"msg"`
		Received float64 `json:"received"`
		Accepted float64 `json:"accepted"`
		Rejected float64 `json:"rejected"`
		UserID   string  `json:"user_id"`
	}
	require.NoError(t, json.Unmarshal(logs.Bytes(), &line), "the sync must emit exactly one JSON log line")
	require.Equal(t, "health: weight sync", line.Msg)
	require.Equal(t, float64(3), line.Received, "received counts what the DEVICE sent -- the anchor evidence")
	require.Equal(t, float64(2), line.Accepted)
	require.Equal(t, float64(1), line.Rejected)
	require.NotEmpty(t, line.UserID, "without the user id the line cannot be attributed -- prod has several accounts")
}

// TestSyncLogsNoWeightValues guards the public-repo rule: these lines get
// quoted into issues, so a weight must never reach them.
func TestSyncLogsNoWeightValues(t *testing.T) {
	logs := captureLogs(t)
	r, _ := testRouter(t)

	body, _ := json.Marshal(SyncRequest{Weights: []WeightRecord{rec(70.4)}})
	req := httptest.NewRequest(http.MethodPost, "/v1/health/sync", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.NotContains(t, logs.String(), "70.4", "a weight value must never be logged")
}
