package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"log/slog"
)

// captureLogger installs a JSON slog handler over a buffer as the process
// default logger for the duration of the test (mirroring the JSON handler
// cmd/api/main.go installs in production), and restores the previous
// default on cleanup.
func captureLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := &bytes.Buffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// logLines parses every JSON line emitted to buf into a map. Empty input
// yields an empty (not nil-panicking) slice.
func logLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	trimmed := strings.TrimSpace(buf.String())
	if trimmed == "" {
		return nil
	}
	var out []map[string]any
	for _, line := range strings.Split(trimmed, "\n") {
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &m))
		out = append(out, m)
	}
	return out
}

func onlyLogLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	lines := logLines(t, buf)
	require.Len(t, lines, 1, "expected exactly one log line")
	return lines[0]
}

// newLoggedEngine wires RequestLogger (and any extra middleware, e.g. a
// fake-auth stand-in that sets user_id) ahead of the given handler under
// method+path.
func newLoggedEngine(method, path string, handler gin.HandlerFunc, extra ...gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestLogger())
	for _, mw := range extra {
		r.Use(mw)
	}
	r.Handle(method, path, handler)
	return r
}

func doRequest(r *gin.Engine, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	req, _ := http.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestRequestLogger_2xxLogsInfoWithCoreFields(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/widgets/:id", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	doRequest(r, http.MethodGet, "/v1/widgets/42", nil)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, "INFO", entry["level"])
	assert.Equal(t, "GET", entry["method"])
	assert.Equal(t, "/v1/widgets/:id", entry["route"])
	assert.Equal(t, float64(http.StatusOK), entry["status"])
	assert.Contains(t, entry, "latency_ms")
}

func TestRequestLogger_4xxLogsWarn(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/widgets/:id", func(c *gin.Context) {
		c.Status(http.StatusBadRequest)
	})

	doRequest(r, http.MethodGet, "/v1/widgets/42", nil)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, "WARN", entry["level"])
	assert.Equal(t, float64(http.StatusBadRequest), entry["status"])
}

func TestRequestLogger_5xxLogsError(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/widgets/:id", func(c *gin.Context) {
		c.Status(http.StatusInternalServerError)
	})

	doRequest(r, http.MethodGet, "/v1/widgets/42", nil)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, "ERROR", entry["level"])
	assert.Equal(t, float64(http.StatusInternalServerError), entry["status"])
}

func TestRequestLogger_SkipsHealthAndReady(t *testing.T) {
	buf := captureLogger(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(RequestLogger())
	r.GET("/health", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/ready", func(c *gin.Context) { c.Status(http.StatusOK) })

	doRequest(r, http.MethodGet, "/health", nil)
	doRequest(r, http.MethodGet, "/ready", nil)

	assert.Empty(t, strings.TrimSpace(buf.String()), "expected no log output for health/ready probes")
}

func TestRequestLogger_UserIDPresentWhenAuthenticated(t *testing.T) {
	buf := captureLogger(t)
	userID := uuid.New()
	// Sets the exact context key user.IDFromContext reads ("user_id"),
	// bypassing user.ResolveMiddleware — the idiom used throughout this
	// codebase's handler tests (e.g. feedback/handler_test.go).
	r := newLoggedEngine(http.MethodGet, "/v1/me", func(c *gin.Context) {
		c.Status(http.StatusOK)
	}, func(c *gin.Context) {
		c.Set("user_id", userID)
		c.Next()
	})

	doRequest(r, http.MethodGet, "/v1/me", nil)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, userID.String(), entry["user_id"])
}

func TestRequestLogger_UserIDAbsentWhenUnauthenticated(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/me", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	doRequest(r, http.MethodGet, "/v1/me", nil)

	entry := onlyLogLine(t, buf)
	assert.NotContains(t, entry, "user_id", "user_id must be omitted, not logged as a nil UUID, when absent")
}

func TestRequestLogger_SetsRequestIDHeaderAndLogsIt(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/widgets/:id", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	w := doRequest(r, http.MethodGet, "/v1/widgets/42", nil)

	respID := w.Header().Get("X-Request-Id")
	require.NotEmpty(t, respID)
	_, err := uuid.Parse(respID)
	require.NoError(t, err, "generated request id should be a valid UUID")

	entry := onlyLogLine(t, buf)
	assert.Equal(t, respID, entry["request_id"])
}

func TestRequestLogger_HonoursClientSuppliedRequestID(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/widgets/:id", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	clientID := "client-supplied-id-123"
	w := doRequest(r, http.MethodGet, "/v1/widgets/42", map[string]string{"X-Request-Id": clientID})

	assert.Equal(t, clientID, w.Header().Get("X-Request-Id"))
	entry := onlyLogLine(t, buf)
	assert.Equal(t, clientID, entry["request_id"])
}

// TestRequestLogger_PanicProducesErrorLogAndPropagates is Finding 1: a
// panicking handler must still leave exactly one correlatable trace, and the
// panic must still reach gin.Recovery() (registered outer to RequestLogger,
// exactly as in router.go) so the client still gets its 500.
func TestRequestLogger_PanicProducesErrorLogAndPropagates(t *testing.T) {
	buf := captureLogger(t)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(RequestLogger())
	r.GET("/v1/boom", func(c *gin.Context) {
		panic("kaboom")
	})

	var w *httptest.ResponseRecorder
	require.NotPanics(t, func() {
		w = doRequest(r, http.MethodGet, "/v1/boom", nil)
	}, "gin.Recovery() must still catch the panic; RequestLogger must not call recover()")

	assert.Equal(t, http.StatusInternalServerError, w.Code)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, "ERROR", entry["level"])
	assert.Equal(t, "/v1/boom", entry["route"])
	assert.Equal(t, float64(http.StatusInternalServerError), entry["status"],
		"status must be recorded as 500 (what Recovery will send), not the in-flight default 200")
	assert.Equal(t, true, entry["panic"], "a panicking request must be marked so it is greppable")
	assert.NotEmpty(t, entry["request_id"])
}

// TestRequestLogger_ReadyFailureLogsError is Finding 2: probes are skipped to
// keep Kubernetes noise out of the logs, but a FAILING readiness probe is an
// infra signal that must still leave a trace.
func TestRequestLogger_ReadyFailureLogsError(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/ready", func(c *gin.Context) {
		c.Status(http.StatusServiceUnavailable)
	})

	doRequest(r, http.MethodGet, "/ready", nil)

	entry := onlyLogLine(t, buf)
	assert.Equal(t, "ERROR", entry["level"])
	assert.Equal(t, "/ready", entry["route"])
	assert.Equal(t, float64(http.StatusServiceUnavailable), entry["status"])
}

// TestRequestLogger_NeverLeaksSensitiveQueryString is the important test.
// GET /v1/foods?q=chicken+breast carries the user's search phrase — a food
// description, which is health data — in the query string. This test
// asserts on the WHOLE rendered log line, not on individual fields, so that
// a future change adding (say) RawQuery to any field trips it, not just a
// hypothetical "query" field.
func TestRequestLogger_NeverLeaksSensitiveQueryString(t *testing.T) {
	buf := captureLogger(t)
	r := newLoggedEngine(http.MethodGet, "/v1/foods", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	doRequest(r, http.MethodGet, "/v1/foods?q=chicken+breast", nil)

	lines := logLines(t, buf)
	require.Len(t, lines, 1)
	raw, err := json.Marshal(lines[0])
	require.NoError(t, err)
	assert.NotContains(t, strings.ToLower(string(raw)), "chicken",
		"log line must never contain the search phrase from the query string")
}
