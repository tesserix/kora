package aitrace

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tesserix/kora/api/internal/ai"
)

func recordSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)))
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	return recorder
}

func attrs(kv []attribute.KeyValue) map[string]attribute.Value {
	out := map[string]attribute.Value{}
	for _, a := range kv {
		out[string(a.Key)] = a.Value
	}
	return out
}

func routeUnder(name string, key []byte, userID uuid.UUID, handler gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/x", func(c *gin.Context) {
		if userID != uuid.Nil {
			c.Set("user_id", userID)
		}
		c.Next()
	}, Route(name, key), handler)
	return r
}

func TestSetupWithAnUnreachableCollectorNeverFailsARequest(t *testing.T) {
	shutdown, err := Setup(context.Background(), Config{Endpoint: "http://127.0.0.1:1", Environment: "test"})
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(func() { otel.SetTracerProvider(sdktrace.NewTracerProvider()) })

	r := routeUnder("coach.ask", nil, uuid.Nil, func(c *gin.Context) { c.Status(http.StatusOK) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/x", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want the handler's 200 with no collector listening", w.Code)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	_ = shutdown(ctx)
	if time.Since(start) > 3*time.Second {
		t.Fatalf("shutdown took %s, want it bounded by its context", time.Since(start))
	}
}

func TestSetupWithoutAnEndpointIsANoop(t *testing.T) {
	shutdown, err := Setup(context.Background(), Config{})
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}

func TestResourceMarksSpansAsKoraAI(t *testing.T) {
	res := resourceFor(Config{Environment: "production", Release: "abc123"})
	got := attrs(res.Attributes())
	want := map[string]string{
		"service.name":                "kora-api",
		"service.namespace":           "kora",
		"tesserix.signal":             "ai",
		"deployment.environment.name": "production",
		"service.version":             "abc123",
	}
	for k, v := range want {
		if got[k].AsString() != v {
			t.Errorf("resource %s = %q, want %q", k, got[k].AsString(), v)
		}
	}
}

func TestRouteOpensOneTraceNamedForTheCapability(t *testing.T) {
	recorder := recordSpans(t)
	key := []byte("test-user-key")
	userID := uuid.New()

	r := routeUnder("capture.photo", key, userID, func(c *gin.Context) { c.Status(http.StatusBadGateway) })
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/x", strings.NewReader("secret meal text")))

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("spans = %d, want one root span", len(spans))
	}
	span := spans[0]
	if span.Name() != "capture.photo" {
		t.Errorf("name = %q, want capture.photo", span.Name())
	}
	got := attrs(span.Attributes())
	if got["langfuse.trace.name"].AsString() != "capture.photo" {
		t.Errorf("langfuse.trace.name = %q", got["langfuse.trace.name"].AsString())
	}
	hashed := got["langfuse.user.id"].AsString()
	if hashed == "" || hashed == userID.String() || strings.Contains(hashed, userID.String()) {
		t.Errorf("langfuse.user.id = %q, want an HMAC that never carries the raw id", hashed)
	}
	if hashed != HashUser(key, userID) {
		t.Errorf("langfuse.user.id = %q, want the stable HMAC %q", hashed, HashUser(key, userID))
	}
	if got["http.response.status_code"].AsInt64() != http.StatusBadGateway {
		t.Errorf("status attribute = %v, want 502", got["http.response.status_code"])
	}
	for _, a := range span.Attributes() {
		if strings.Contains(a.Value.Emit(), "secret meal text") {
			t.Errorf("attribute %s carries request content", a.Key)
		}
	}
}

func TestRouteOmitsTheUserWithoutAKey(t *testing.T) {
	recorder := recordSpans(t)

	r := routeUnder("coach.ask", nil, uuid.New(), func(c *gin.Context) { c.Status(http.StatusOK) })
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/x", nil))

	got := attrs(recorder.Ended()[0].Attributes())
	if _, ok := got["langfuse.user.id"]; ok {
		t.Error("langfuse.user.id set without a key, want it omitted rather than unhashed")
	}
}

func TestHashUserDependsOnTheKey(t *testing.T) {
	id := uuid.New()
	if HashUser([]byte("a"), id) == HashUser([]byte("b"), id) {
		t.Error("HashUser ignores the key")
	}
	if HashUser([]byte("a"), id) != HashUser([]byte("a"), id) {
		t.Error("HashUser is not stable")
	}
}

func TestGenerationRecordsUsageAsAChildSpan(t *testing.T) {
	recorder := recordSpans(t)
	ctx, root := otel.Tracer("test").Start(context.Background(), "coach.ask")

	Generation(ctx, ai.Usage{
		Provider: "gateway", Model: "kora-auto", CallType: "coach",
		TokensIn: 120, TokensOut: 40, LatencyMs: 900, Outcome: "ok",
	}, 0.0021)
	root.End()

	spans := recorder.Ended()
	if len(spans) != 2 {
		t.Fatalf("spans = %d, want the generation and its root", len(spans))
	}
	gen := spans[0]
	if gen.Parent().SpanID() != root.SpanContext().SpanID() {
		t.Error("generation is not a child of the request span")
	}
	if gen.Name() != "ai.coach" {
		t.Errorf("name = %q, want ai.coach", gen.Name())
	}
	if d := gen.EndTime().Sub(gen.StartTime()); d != 900*time.Millisecond {
		t.Errorf("duration = %s, want the provider latency", d)
	}
	got := attrs(gen.Attributes())
	if got["gen_ai.request.model"].AsString() != "kora-auto" ||
		got["gen_ai.usage.input_tokens"].AsInt64() != 120 ||
		got["gen_ai.usage.output_tokens"].AsInt64() != 40 ||
		got["gen_ai.usage.cost"].AsFloat64() != 0.0021 ||
		got["kora.ai.outcome"].AsString() != "ok" {
		t.Errorf("generation attributes = %v", got)
	}
}

func TestInjectWritesTraceparentForTheActiveSpan(t *testing.T) {
	recordSpans(t)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	ctx, span := otel.Tracer("test").Start(context.Background(), "agent.run")
	defer span.End()

	header := http.Header{}
	Inject(ctx, header)
	tp := header.Get("traceparent")
	if !strings.Contains(tp, span.SpanContext().TraceID().String()) {
		t.Errorf("traceparent = %q, want the active trace id", tp)
	}
}
