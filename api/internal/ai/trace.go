package ai

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// startSpan opens a resolver stage under the request's trace; it records counts and scores, never food names.
func startSpan(ctx context.Context, name string) (context.Context, trace.Span) {
	return otel.Tracer("github.com/tesserix/kora/api/internal/ai").Start(ctx, name)
}

func traceOutcome(ctx context.Context, o ResolveOutcome) {
	_, span := startSpan(ctx, "resolve.tier")
	defer span.End()
	span.SetAttributes(
		attribute.String("kora.resolve.outcome", o.Kind),
		attribute.String("kora.resolve.mode", o.Mode),
		attribute.String("kora.resolve.tier", o.Tier),
		attribute.Int("kora.resolve.candidates", o.CandidateCount),
	)
	if o.TopScore != nil {
		span.SetAttributes(attribute.Float64("kora.resolve.top_score", *o.TopScore))
	}
}
