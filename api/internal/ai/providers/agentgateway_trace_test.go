package providers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TestGatewayPropagatesActiveTraceAcrossEveryCapability(t *testing.T) {
	previous := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previous) })
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled,
	})
	tests := []struct {
		name string
		call func(context.Context, AgentGatewayProvider)
	}{
		{"text", func(ctx context.Context, p AgentGatewayProvider) { _, _, _ = p.IdentifyText(ctx, "apple") }},
		{"photo", func(ctx context.Context, p AgentGatewayProvider) {
			_, _, _ = p.IdentifyPhoto(ctx, []byte("image"), "image/jpeg")
		}},
		{"body composition", func(ctx context.Context, p AgentGatewayProvider) {
			_, _, _ = p.IdentifyBodyComposition(ctx, []byte("image"), "image/jpeg")
		}},
		{"decompose", func(ctx context.Context, p AgentGatewayProvider) { _, _, _ = p.Decompose(ctx, "salad") }},
		{"embedding", func(ctx context.Context, p AgentGatewayProvider) { _, _, _ = p.Embed(ctx, "apple") }},
		{"voice", func(ctx context.Context, p AgentGatewayProvider) {
			_, _, _ = p.Transcribe(ctx, []byte("audio"), "audio/m4a")
		}},
		{"coach", func(ctx context.Context, p AgentGatewayProvider) { _, _, _ = p.GenerateText(ctx, "system", "question") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			headers := make(chan http.Header, 2)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				headers <- r.Header.Clone()
				// A non-retryable upstream response lets this test inspect the wire request for every payload shape.
				w.WriteHeader(http.StatusBadRequest)
			}))
			defer server.Close()
			provider := NewAgentGatewayProvider("test-key", server.URL+"/v1", "kora-auto")
			tt.call(trace.ContextWithSpanContext(t.Context(), sc), provider)
			require.Equal(t, "00-"+sc.TraceID().String()+"-"+sc.SpanID().String()+"-01", (<-headers).Get("traceparent"))
			tt.call(t.Context(), provider)
			require.Empty(t, (<-headers).Get("traceparent"), "a reused provider must not leak another request's trace")
		})
	}
}
