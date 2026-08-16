package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/genai"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// The retry tests assert how many attempts happen, not how long they wait.
// Zeroing the backoff keeps them fast.
func init() { embedBaseDelay = 0 }

type fakeStore struct {
	batches [][]nutrition.FoodItem
	call    int
	stored  map[uuid.UUID]bool
}

func (f *fakeStore) RowsMissingEmbedding(_ context.Context, _ int) ([]nutrition.FoodItem, error) {
	if f.call >= len(f.batches) {
		return nil, nil
	}
	b := f.batches[f.call]
	f.call++
	return b, nil
}

func (f *fakeStore) SetEmbedding(_ context.Context, id uuid.UUID, _ []float32) error {
	if f.stored == nil {
		f.stored = map[uuid.UUID]bool{}
	}
	f.stored[id] = true
	return nil
}

// flakyEmbedder fails the first failures[name] calls for a given name, then
// succeeds; alwaysErr makes every call fail forever.
type flakyEmbedder struct {
	failures  map[string]int
	alwaysErr bool
}

func (e *flakyEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	if e.alwaysErr {
		return nil, errors.New("provider down")
	}
	if e.failures[text] > 0 {
		e.failures[text]--
		return nil, errors.New("transient")
	}
	return make([]float32, 768), nil
}

func TestRunRetriesTransientFailures(t *testing.T) {
	row := nutrition.FoodItem{ID: uuid.New(), Name: "Flaky food"}
	s := &fakeStore{batches: [][]nutrition.FoodItem{{row}}}
	// Fails twice, succeeds on the third attempt — within the 3-attempt budget.
	e := &flakyEmbedder{failures: map[string]int{"Flaky food": 2}}

	embedded, failed := run(context.Background(), s, e)

	assert.Equal(t, 1, embedded)
	assert.Equal(t, 0, failed)
	assert.True(t, s.stored[row.ID])
}

func TestRunCountsPersistentFailures(t *testing.T) {
	row := nutrition.FoodItem{ID: uuid.New(), Name: "Doomed food"}
	s := &fakeStore{batches: [][]nutrition.FoodItem{{row}}}
	e := &flakyEmbedder{alwaysErr: true}

	embedded, failed := run(context.Background(), s, e)

	assert.Equal(t, 0, embedded)
	assert.Equal(t, 1, failed)
	// The whole-batch bail-out must stop the loop rather than spinning forever
	// on rows that are never marked done.
	assert.Equal(t, 1, s.call)
}

// TestRunContinuesPastAPartialBatchFailure pins the shape Ruling 1 turned
// green: a row that cannot be embedded does not abort the run, the next batch
// is still fetched and embedded, and the run reports both the progress and the
// failure — which exitCode then reads as success.
func TestRunContinuesPastAPartialBatchFailure(t *testing.T) {
	good1 := nutrition.FoodItem{ID: uuid.New(), Name: "Good food one"}
	doomed := nutrition.FoodItem{ID: uuid.New(), Name: "Doomed food"}
	good2 := nutrition.FoodItem{ID: uuid.New(), Name: "Good food two"}

	s := &fakeStore{batches: [][]nutrition.FoodItem{{good1, doomed}, {good2}}}
	// Doomed food exhausts the whole attempt budget and never succeeds; the
	// other two rows embed first time.
	e := &flakyEmbedder{failures: map[string]int{"Doomed food": embedAttempts}}

	embedded, failed := run(context.Background(), s, e)

	assert.Equal(t, 2, embedded, "both good rows must be embedded")
	assert.Equal(t, 1, failed, "the doomed row must still be counted as failed")
	assert.True(t, s.stored[good1.ID])
	assert.True(t, s.stored[good2.ID])
	assert.False(t, s.stored[doomed.ID], "a failed embed must never mark the row done")
	// The partial failure must NOT stop the loop: the second batch was fetched.
	assert.Equal(t, 2, s.call, "run must continue to the next batch after a partial failure")
	// And under Ruling 1 this run is a success — it made real progress.
	assert.Equal(t, 0, exitCode(embedded, failed))
}

func TestExitCode(t *testing.T) {
	tests := []struct {
		name             string
		embedded, failed int
		want             int
	}{
		{name: "nothing to do is success", embedded: 0, failed: 0, want: 0},
		{name: "all embedded is success", embedded: 10, failed: 0, want: 0},
		// Ruling 1: progress means green. A run that embedded rows stays
		// successful even with failures, so one permanently un-embeddable row
		// cannot red-line every deploy forever and a partial rate-limit
		// failure cannot trigger up to six re-runs of the whole seed/ingest/
		// embed chain against an already-exhausted quota. The slow leak is
		// caught by the kora_food_index_missing gauge instead.
		{name: "progress with some failures is success", embedded: 10, failed: 1, want: 0},
		{name: "one embedded row is enough to stay green", embedded: 1, failed: 99, want: 0},
		// The 2026-08-02 signature, and the only red: the run achieved nothing
		// while rows were missing, yet would otherwise have reported success.
		{name: "embedded nothing while rows failed is a failure", embedded: 0, failed: 5, want: 1},
		{name: "a single total failure is a failure", embedded: 0, failed: 1, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, exitCode(tt.embedded, tt.failed))
		})
	}
}

// TestChooseBackend pins the precedence, which must stay identical to
// cmd/api's buildResolveHandler: Vertex over the API key, never the other way
// round. Getting it backwards is not a compile error and not a runtime error —
// the backfill simply runs on the free tier's 1,000/day embedding cap again
// and quietly takes a fortnight (kora#97).
func TestChooseBackend(t *testing.T) {
	tests := []struct {
		name          string
		vertexProject string
		geminiAPIKey  string
		want          embedBackend
	}{
		{name: "nothing configured", want: backendNone},
		{name: "api key only falls back to gemini", geminiAPIKey: "key", want: backendGemini},
		{name: "vertex only", vertexProject: "tesseracthub-480811", want: backendVertex},
		{
			// The case that matters: production has BOTH, because the key is
			// still in the environment. Vertex must win.
			name:          "vertex wins when both are configured",
			vertexProject: "tesseracthub-480811",
			geminiAPIKey:  "key",
			want:          backendVertex,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, chooseBackend(tt.vertexProject, tt.geminiAPIKey))
		})
	}
}

// countingEmbedder records how many times Embed was called and always fails
// with err. It exists to assert the ATTEMPT COUNT, which is the whole point of
// the rate-limit exemption.
type countingEmbedder struct {
	calls int
	err   error
}

func (e *countingEmbedder) Embed(_ context.Context, _ string) ([]float32, error) {
	e.calls++
	return nil, e.err
}

func TestEmbedWithRetryAttempts(t *testing.T) {
	tests := []struct {
		name         string
		err          error
		wantAttempts int
	}{
		{
			// A 429 wrapped exactly as providers.GeminiProvider.Embed wraps it.
			name: "a rate-limited row is failed after a single attempt",
			err: fmt.Errorf("gemini: embed: %w", genai.APIError{
				Code:    http.StatusTooManyRequests,
				Status:  "RESOURCE_EXHAUSTED",
				Message: "Quota exceeded for quota metric 'Embed requests'",
			}),
			wantAttempts: 1,
		},
		{
			// The message-only backstop, for an error that lost its type.
			name:         "a stringified quota error is also not retried",
			err:          errors.New("provider error: 429 Too Many Requests"),
			wantAttempts: 1,
		},
		{
			// A genuine transient blip still gets the full budget — this is
			// the failure mode that lost 69 rows on 2026-08-02.
			name:         "a generic transient error still gets the full budget",
			err:          errors.New("connection reset by peer"),
			wantAttempts: embedAttempts,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := &countingEmbedder{err: tt.err}
			vec, err := embedWithRetry(context.Background(), e, "Some food")
			require.Error(t, err)
			assert.Nil(t, vec)
			assert.Equal(t, tt.wantAttempts, e.calls)
		})
	}
}
