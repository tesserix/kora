package coach

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tesserix/kora/api/internal/ai"
)

func TestClassifyRouteTracesTheDecisionWithoutTheMessage(t *testing.T) {
	tests := []struct {
		name     string
		provider ai.Provider
		route    string
		failed   bool
	}{
		{name: "classified", provider: &fakeProvider{text: "plan"}, route: RoutePlan},
		{name: "provider failure falls back to log", provider: &errorProvider{}, route: RouteLog, failed: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := tracetest.NewSpanRecorder()
			previous := otel.GetTracerProvider()
			otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)))
			t.Cleanup(func() { otel.SetTracerProvider(previous) })

			s := NewService(nil, tt.provider, nil, nil)
			if got := s.ClassifyRoute(context.Background(), "help me plan dinners"); got != tt.route {
				t.Fatalf("route = %q, want %q", got, tt.route)
			}

			spans := recorder.Ended()
			if len(spans) != 1 || spans[0].Name() != "intent.classify" {
				t.Fatalf("spans = %v, want one intent.classify", spans)
			}
			attrs := map[string]string{}
			for _, a := range spans[0].Attributes() {
				attrs[string(a.Key)] = a.Value.Emit()
				if a.Value.Emit() == "help me plan dinners" {
					t.Errorf("attribute %s carries the message", a.Key)
				}
			}
			if attrs["kora.intent.route"] != tt.route {
				t.Errorf("kora.intent.route = %q, want %q", attrs["kora.intent.route"], tt.route)
			}
			if failed := spans[0].Status().Code == codes.Error; failed != tt.failed {
				t.Errorf("error status = %t, want %t", failed, tt.failed)
			}
		})
	}
}
