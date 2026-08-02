package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/user"
)

// RequestLogger emits one structured slog line per request, so a failure a
// user reports ("it said something went wrong") leaves a trace to
// investigate instead of nothing at all.
//
// PRIVACY (do not weaken this): Kora logs what people eat, and food phrases
// are health data. GET /v1/foods?q=<phrase> carries the search phrase in its
// query string; POST /v1/resolve/text carries a free-text meal description
// in its body. This middleware therefore NEVER logs the raw query string
// (c.Request.URL.RawQuery), the raw request path/URI
// (c.Request.URL.Path / c.Request.RequestURI), the request body, the
// response body, or any request headers. The only path-shaped field logged
// is c.FullPath(), which is the matched route TEMPLATE (e.g. "/v1/logs/:id")
// — it contains no user-supplied values. Do not add RawQuery, the request
// body, or headers here for the sake of debuggability; use request_id to
// correlate with client-side logs instead.
func RequestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.FullPath() {
		case "/health", "/ready":
			c.Next()
			return
		}

		reqID := c.GetHeader("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		c.Header("X-Request-Id", reqID)

		start := time.Now()
		c.Next()
		latency := time.Since(start)

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}

		status := c.Writer.Status()

		attrs := []any{
			slog.String("method", c.Request.Method),
			slog.String("route", route),
			slog.Int("status", status),
			slog.Int64("latency_ms", latency.Milliseconds()),
			slog.String("request_id", reqID),
		}

		if id, ok := user.IDFromContext(c); ok {
			attrs = append(attrs, slog.String("user_id", id.String()))
		}

		// Nothing in this codebase calls c.Error() today, so this is always
		// empty in practice and exists for whatever first does. Note it is
		// the one field here whose content is not controlled by this file:
		// if you pass user input to c.Error() — a binding failure echoing a
		// submitted value, say — it lands in the logs. Wrap such errors so
		// the message carries the field NAME, never the value.
		if errs := c.Errors.String(); errs != "" {
			attrs = append(attrs, slog.String("errors", errs))
		}

		switch {
		case status >= http.StatusInternalServerError:
			slog.Error("http_request", attrs...)
		case status >= http.StatusBadRequest:
			slog.Warn("http_request", attrs...)
		default:
			slog.Info("http_request", attrs...)
		}
	}
}
