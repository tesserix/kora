package ai

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestResolveTracesEachStageWithoutThePhrase(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	db := testDB(t)
	userID := seedTestUser(t, db)
	r := NewResolver(&stubProvider{
		guesses:   []Guess{{Food: "zzqx unindexed dish", Confidence: 0.9}},
		embedding: make([]float32, 768),
	}, nutrition.NewRepository(db), NoCache{}, &stubMeter{withinBudget: true})

	ctx, root := provider.Tracer("test").Start(context.Background(), "capture.text")
	_, err := r.ResolveText(ctx, userID, "private phrase")
	root.End()
	require.NoError(t, err)

	spans := map[string]sdktrace.ReadOnlySpan{}
	for _, s := range recorder.Ended() {
		spans[s.Name()] = s
		assert.Equal(t, root.SpanContext().TraceID(), s.SpanContext().TraceID(), s.Name())
		for _, a := range s.Attributes() {
			assert.NotContains(t, a.Value.Emit(), "private phrase", "%s.%s", s.Name(), a.Key)
			assert.NotContains(t, a.Value.Emit(), "zzqx", "%s.%s", s.Name(), a.Key)
		}
	}
	for _, name := range []string{"resolve.model", "resolve.index_match", "resolve.embed", "resolve.tier"} {
		require.Contains(t, spans, name)
	}
	tier := map[string]string{}
	for _, a := range spans["resolve.tier"].Attributes() {
		tier[string(a.Key)] = a.Value.Emit()
	}
	assert.Equal(t, outcomeNoMatch, tier["kora.resolve.outcome"])
	assert.Equal(t, modeText, tier["kora.resolve.mode"])
	assert.Equal(t, "0", tier["kora.resolve.candidates"])
}
