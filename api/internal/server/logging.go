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
		route := c.FullPath()
		isProbe := route == "/health" || route == "/ready"

		reqID := c.GetHeader("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		// Probe requests (Kubernetes liveness/readiness checks) never get an
		// X-Request-Id response header — there is no client on the other end
		// to correlate against. reqID is still computed above and still used
		// in the log line below when a probe fails and gets logged.
		if !isProbe {
			c.Header("X-Request-Id", reqID)
		}

		start := time.Now()
		completed := false

		// Registered as a defer (not run straight-line after c.Next()) so it
		// still executes when a handler panics: gin.Recovery() is the OUTER
		// middleware (see router.go), so on panic the stack unwinds straight
		// past a straight-line post-c.Next() block to Recovery, which logs
		// only an unstructured stack trace with no request_id/route/status —
		// exactly the "no server-side trace" gap this middleware exists to
		// close. This defer does NOT call recover(): it only observes the
		// unwind, then lets it continue to gin.Recovery(), which is what
		// actually stops the panic and writes the 500.
		defer func() {
			latency := time.Since(start)

			// completed is set to true only after c.Next() returns normally.
			// If we get here with it still false, we are running during a
			// panic unwind: gin.Recovery() has not yet run (it recovers
			// further up the stack, after this defer returns), so
			// c.Writer.Status() would still read the in-flight default 200 —
			// logging a panicking request as a success. Override with the
			// 500 Recovery is actually about to send.
			panicked := !completed
			status := c.Writer.Status()
			if panicked {
				status = http.StatusInternalServerError
			}

			// Probes are skipped to keep Kubernetes health/ready polling
			// noise out of the logs, but only when they succeed — a failing
			// /ready (e.g. 503, DB unreachable) is exactly the kind of infra
			// signal this middleware exists to preserve.
			if isProbe && !panicked && status >= http.StatusOK && status < http.StatusMultipleChoices {
				return
			}

			routeAttr := route
			if routeAttr == "" {
				routeAttr = "unmatched"
			}

			attrs := []any{
				slog.String("method", c.Request.Method),
				slog.String("route", routeAttr),
				slog.Int("status", status),
				slog.Int64("latency_ms", latency.Milliseconds()),
				slog.String("request_id", reqID),
			}

			if panicked {
				// Greppable marker: this status is Recovery's, not the
				// handler's — see the comment above.
				attrs = append(attrs, slog.Bool("panic", true))
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
			case panicked, status >= http.StatusInternalServerError:
				slog.Error("http_request", attrs...)
			case status >= http.StatusBadRequest:
				slog.Warn("http_request", attrs...)
			default:
				slog.Info("http_request", attrs...)
			}
		}()

		c.Next()
		completed = true
	}
}
