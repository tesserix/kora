// Package aitrace exports one OpenTelemetry trace per AI request to the
// otel-gateway, marked so the AI pipeline forwards it to Kora's Langfuse
// project. It carries ids, models, tokens and outcomes, never user content.
package aitrace

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/user"
)

const exportTimeout = 5 * time.Second

// Config selects the collector and labels the traces. An empty Endpoint disables export.
type Config struct {
	Endpoint    string
	Environment string
	Release     string
}

// Setup installs the global tracer provider and W3C propagator. Export runs
// in the background, so an unreachable collector drops spans and never fails a request.
func Setup(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	if cfg.Endpoint == "" {
		return func(context.Context) error { return nil }, nil
	}
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(cfg.Endpoint),
		otlptracehttp.WithTimeout(exportTimeout),
	)
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resourceFor(cfg)),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		slog.Warn("aitrace: export failed", "err", err)
	}))
	return provider.Shutdown, nil
}

func resourceFor(cfg Config) *resource.Resource {
	return resource.NewSchemaless(
		attribute.String("service.name", "kora-api"),
		attribute.String("service.namespace", "kora"),
		attribute.String("service.version", cfg.Release),
		attribute.String("tesserix.signal", "ai"),
		attribute.String("deployment.environment.name", cfg.Environment),
	)
}

func tracer() trace.Tracer { return otel.Tracer("github.com/tesserix/kora/api/internal/aitrace") }

// HashUser is the only form of a user id that leaves Kora in a trace.
func HashUser(key []byte, id uuid.UUID) string {
	mac := hmac.New(sha256.New, key)
	mac.Write(id[:])
	return hex.EncodeToString(mac.Sum(nil))
}

// Route opens the request's root span under name. Without a key the user is omitted, never sent raw.
func Route(name string, userKey []byte) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, span := tracer().Start(c.Request.Context(), name, trace.WithSpanKind(trace.SpanKindServer))
		defer span.End()

		span.SetAttributes(attribute.String("langfuse.trace.name", name))
		if id, ok := user.IDFromContext(c); ok && len(userKey) > 0 {
			hashed := HashUser(userKey, id)
			span.SetAttributes(
				attribute.String("langfuse.user.id", hashed),
				attribute.String("langfuse.session.id", hashed),
			)
		}

		c.Request = c.Request.WithContext(ctx)
		c.Next()

		status := c.Writer.Status()
		span.SetAttributes(attribute.Int("http.response.status_code", status))
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(status))
		}
	}
}

// Start opens a child span of whatever request span ctx carries.
func Start(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	return tracer().Start(ctx, name, trace.WithAttributes(attrs...))
}

// Generation records one provider call as a child span spanning its latency.
func Generation(ctx context.Context, u ai.Usage, costUSD float64) {
	end := time.Now()
	start := end.Add(-time.Duration(u.LatencyMs) * time.Millisecond)
	_, span := tracer().Start(ctx, "ai."+u.CallType,
		trace.WithTimestamp(start),
		trace.WithAttributes(
			attribute.String("gen_ai.system", u.Provider),
			attribute.String("gen_ai.request.model", u.Model),
			attribute.Int("gen_ai.usage.input_tokens", u.TokensIn),
			attribute.Int("gen_ai.usage.output_tokens", u.TokensOut),
			attribute.Float64("gen_ai.usage.cost", costUSD),
			attribute.String("kora.ai.outcome", u.Outcome),
			attribute.Bool("kora.ai.tokens_estimated", u.Estimated),
		),
	)
	if u.Outcome != "" && u.Outcome != ai.OutcomeOK {
		span.SetStatus(codes.Error, u.Outcome)
	}
	span.End(trace.WithTimestamp(end))
}

// Inject writes the active span's traceparent so downstream agents nest under it.
func Inject(ctx context.Context, header http.Header) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(header))
}
