package aieval

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/tesserix/kora/api/internal/ai"
)

func TestMain(m *testing.M) {
	otel.SetTracerProvider(sdktrace.NewTracerProvider())
	os.Exit(m.Run())
}

type fakeResolver map[string]ai.Resolution

func (f fakeResolver) ResolveText(_ context.Context, _ uuid.UUID, phrase string) (ai.Resolution, error) {
	res, ok := f[phrase]
	if !ok {
		return ai.Resolution{}, errors.New("provider down")
	}
	return res, nil
}

func TestRunGradesEachItemAndRecordsItInLangfuse(t *testing.T) {
	f, c := newFakeLangfuse(t, 0)
	resolver := fakeResolver{
		"egg":  resolution(ai.TierAuto, "Egg, boiled", uuid.New(), 155, 0.95),
		"coke": resolution(ai.TierConfirm, "Pepsi", uuid.New(), 1, 0.6),
	}
	items := []Item{
		{ID: "a", Input: Input{Phrase: "egg"}, Expected: Expected{Name: "Egg", Kcal: 150}},
		{ID: "b", Input: Input{Phrase: "coke"}, Expected: Expected{Name: "Coke"}},
		{ID: "c", Input: Input{Phrase: "chicken"}, Expected: Expected{Name: "Chicken"}},
	}

	results, err := Run(t.Context(), resolver, c, "nightly-1", items)

	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 || !results[0].Top1Correct || results[1].Top1Correct || results[2].Top1Correct || !results[2].Graded {
		t.Fatalf("got %+v", results)
	}
	links := f.posts["/api/public/dataset-run-items"]
	if len(links) != 3 {
		t.Fatalf("got %d run items, want one per item", len(links))
	}
	traces := map[any]bool{}
	for _, l := range links {
		if l["runName"] != "nightly-1" || len(l["traceId"].(string)) != 32 {
			t.Fatalf("bad link %v", l)
		}
		traces[l["traceId"]] = true
	}
	if len(traces) != 3 {
		t.Fatalf("items must not share a trace: %v", traces)
	}
	names := map[string]int{}
	for _, s := range f.posts["/api/public/scores"] {
		names[s["name"].(string)]++
	}
	if names[ScoreTop1] != 3 || names[ScoreKcal] != 1 {
		t.Fatalf("got scores %v", names)
	}
}

func TestRunDoesNotScoreAJudgementCall(t *testing.T) {
	f, c := newFakeLangfuse(t, 0)
	resolver := fakeResolver{"chicken": resolution(ai.TierAuto, "Chicken", uuid.New(), 280, 1)}
	if _, err := Run(t.Context(), resolver, c, "nightly-1", []Item{{ID: "a", Input: Input{Phrase: "chicken"}}}); err != nil {
		t.Fatal(err)
	}
	if len(f.posts["/api/public/dataset-run-items"]) != 1 || len(f.posts["/api/public/scores"]) != 0 {
		t.Fatalf("got %v", f.posts)
	}
}

func TestRunRejectsUnrecordedExperiment(t *testing.T) {
	for _, failingPath := range []string{"/api/public/dataset-run-items", "/api/public/scores"} {
		t.Run(failingPath, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == failingPath {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{}`))
			}))
			defer srv.Close()
			resolver := fakeResolver{"egg": resolution(ai.TierAuto, "Egg", uuid.New(), 150, 1)}
			_, err := Run(t.Context(), resolver, NewClient(srv.URL, "pk", "sk"), "nightly", []Item{{ID: "a", Input: Input{Phrase: "egg"}, Expected: Expected{Name: "Egg"}}})
			if err == nil {
				t.Fatal("experiment passed despite failing to record its results")
			}
		})
	}
}
