package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestRunTracesTheAgentAndPropagatesTraceparent(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	previous, previousProp := otel.GetTracerProvider(), otel.GetTextMapPropagator()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)))
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTracerProvider(previous); otel.SetTextMapPropagator(previousProp) })

	registrySrv := twoAgentRegistry(t)
	defer registrySrv.Close()

	var traceparent string
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceparent = r.Header.Get("traceparent")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": body["id"],
			"result": map[string]any{
				"id":        "run-1",
				"status":    map[string]any{"state": "completed"},
				"artifacts": []any{map[string]any{"parts": []any{map[string]any{"kind": "text", "text": "ok"}}}},
			},
		})
	}))
	defer gatewaySrv.Close()

	c := NewCoordinator(
		NewRegistry(RegistryOptions{BaseURL: registrySrv.URL, APIKey: "test-key"}),
		NewGateway(gatewaySrv.URL, "gw-key", nil),
		nil,
	)
	if _, err := c.Run(context.Background(), "nutrition-guidance", "private question"); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var run sdktrace.ReadOnlySpan
	for _, s := range recorder.Ended() {
		if s.Name() == "agent.run" {
			run = s
		}
	}
	if run == nil {
		t.Fatal("no agent.run span recorded")
	}
	if !strings.Contains(traceparent, run.SpanContext().TraceID().String()) ||
		!strings.Contains(traceparent, run.SpanContext().SpanID().String()) {
		t.Errorf("traceparent = %q, want the agent.run span so ADK spans nest under it", traceparent)
	}
	got := map[string]string{}
	for _, a := range run.Attributes() {
		got[string(a.Key)] = a.Value.Emit()
		if strings.Contains(a.Value.Emit(), "private question") {
			t.Errorf("attribute %s carries the prompt", a.Key)
		}
	}
	for k, v := range map[string]string{
		"kora.agent.name": "nutrition-coach", "kora.agent.skill": "nutrition-guidance",
		"kora.agent.outcome": "ok",
	} {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if got["kora.agent.tag"] == "" {
		t.Error("kora.agent.tag missing, want the published version that served the run")
	}
}
