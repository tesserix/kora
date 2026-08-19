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

	"github.com/tesserix/kora/api/internal/ai"
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

func (e *flakyEmbedder) Embed(_ context.Context, text string) ([]float32, ai.Usage, error) {
	u := ai.Usage{Provider: "gemini", Model: "gemini-embedding-001", CallType: "embed"}
	if e.alwaysErr {
		return nil, u, errors.New("provider down")
	}
	if e.failures[text] > 0 {
		e.failures[text]--
		return nil, u, errors.New("transient")
	}
	return make([]float32, 768), u, nil
}

func TestRunRetriesTransientFailures(t *testing.T) {
	row := nutrition.FoodItem{ID: uuid.New(), Name: "Flaky food"}
	s := &fakeStore{batches: [][]nutrition.FoodItem{{row}}}
	// Fails twice, succeeds on the third attempt — within the 3-attempt budget.
	e := &flakyEmbedder{failures: map[string]int{"Flaky food": 2}}

	o := run(context.Background(), s, e, nil)

	assert.Equal(t, 1, o.embedded)
	assert.Equal(t, 0, o.failed)
	assert.False(t, o.gaveUp, "a run that drained the queue has not given up")
	assert.Equal(t, 0, exitCode(o))
	assert.True(t, s.stored[row.ID])
}

func TestRunCountsPersistentFailures(t *testing.T) {
	row := nutrition.FoodItem{ID: uuid.New(), Name: "Doomed food"}
	s := &fakeStore{batches: [][]nutrition.FoodItem{{row}}}
	e := &flakyEmbedder{alwaysErr: true}

	o := run(context.Background(), s, e, nil)

	assert.Equal(t, 0, o.embedded)
	assert.Equal(t, 1, o.failed)
	// The whole-batch bail-out must stop the loop rather than spinning forever
	// on rows that are never marked done.
	assert.Equal(t, 1, s.call)
	assert.True(t, o.gaveUp, "bailing out of a batch is giving up")
	assert.Equal(t, 1, exitCode(o))
}

// TestRunContinuesPastAPartialBatchFailure pins the shape that stays green: a
// row that cannot be embedded does not abort the run, the next batch is still
// fetched and embedded, and the run drains the queue. It reports the failure
// but did not give up, so exitCode reads it as success.
func TestRunContinuesPastAPartialBatchFailure(t *testing.T) {
	good1 := nutrition.FoodItem{ID: uuid.New(), Name: "Good food one"}
	doomed := nutrition.FoodItem{ID: uuid.New(), Name: "Doomed food"}
	good2 := nutrition.FoodItem{ID: uuid.New(), Name: "Good food two"}

	s := &fakeStore{batches: [][]nutrition.FoodItem{{good1, doomed}, {good2}}}
	// Doomed food exhausts the whole attempt budget and never succeeds; the
	// other two rows embed first time.
	e := &flakyEmbedder{failures: map[string]int{"Doomed food": embedAttempts}}

	o := run(context.Background(), s, e, nil)

	assert.Equal(t, 2, o.embedded, "both good rows must be embedded")
	assert.Equal(t, 1, o.failed, "the doomed row must still be counted as failed")
	assert.True(t, s.stored[good1.ID])
	assert.True(t, s.stored[good2.ID])
	assert.False(t, s.stored[doomed.ID], "a failed embed must never mark the row done")
	// The partial failure must NOT stop the loop: the second batch was fetched.
	assert.Equal(t, 2, s.call, "run must continue to the next batch after a partial failure")
	// The queue drained, so this run is a success despite the failed row.
	assert.False(t, o.gaveUp)
	assert.Equal(t, 0, exitCode(o))
}

// TestRunGivingUpAfterProgressIsAFailure is the kora#97 regression, and the
// case the previous "progress means green" rule got wrong. The run embeds a
// whole first batch, then hits a batch nothing succeeds in and stops with rows
// still outstanding. It made real progress — and it must still be RED, because
// it did not finish what it was asked to do. Under the old rule this exact
// shape exited 0, the Job reported Complete, and the index sat at 42%.
func TestRunGivingUpAfterProgressIsAFailure(t *testing.T) {
	good := nutrition.FoodItem{ID: uuid.New(), Name: "Good food"}
	doomed := nutrition.FoodItem{ID: uuid.New(), Name: "Doomed food"}

	s := &fakeStore{batches: [][]nutrition.FoodItem{{good}, {doomed}}}
	e := &flakyEmbedder{failures: map[string]int{"Doomed food": embedAttempts}}

	o := run(context.Background(), s, e, nil)

	assert.Equal(t, 1, o.embedded, "the first batch really was embedded")
	assert.Equal(t, 1, o.failed)
	assert.True(t, o.gaveUp, "stopping with rows still outstanding is giving up")
	assert.Equal(t, 1, exitCode(o), "a run that gave up must not report success, however much it embedded first")
}

// errStore fails the fetch after serving errAfter batches, standing in for the
// database going away mid-run.
type errStore struct {
	fakeStore
	errAfter int
}

func (s *errStore) RowsMissingEmbedding(ctx context.Context, limit int) ([]nutrition.FoodItem, error) {
	if s.call >= s.errAfter {
		return nil, errors.New("connection refused")
	}
	return s.fakeStore.RowsMissingEmbedding(ctx, limit)
}

// TestRunFetchErrorIsAFailure covers the other way run stops with work
// outstanding: it cannot even read the queue. Nothing was drained, so this is
// not a completed run whatever it embedded first.
func TestRunFetchErrorIsAFailure(t *testing.T) {
	good := nutrition.FoodItem{ID: uuid.New(), Name: "Good food"}
	s := &errStore{fakeStore: fakeStore{batches: [][]nutrition.FoodItem{{good}}}, errAfter: 1}
	e := &flakyEmbedder{}

	o := run(context.Background(), s, e, nil)

	assert.Equal(t, 1, o.embedded)
	assert.True(t, o.gaveUp)
	assert.Equal(t, 1, exitCode(o))
}

// fakeRecorder captures every metered call. err makes recording fail, which
// must never be allowed to break the backfill.
type fakeRecorder struct {
	usages []ai.Usage
	costs  []float64
	err    error
}

func (r *fakeRecorder) RecordSystem(_ context.Context, u ai.Usage, costUSD float64) error {
	r.usages = append(r.usages, u)
	r.costs = append(r.costs, costUSD)
	return r.err
}

// TestRunRecordsUsageForEveryProviderCall is the kora#97 metering regression:
// before this, the embedder interface threw ai.Usage away and the backfill —
// the system's single largest embedding consumer — appeared nowhere in
// ai_usage_events or kora_ai_calls_total.
//
// It asserts EVERY attempt is recorded, failures included, with the right
// outcome. Recording only the successes would let a failing backfill read as
// free, which is the same under-count #81 removed from the user-facing path.
func TestRunRecordsUsageForEveryProviderCall(t *testing.T) {
	flaky := nutrition.FoodItem{ID: uuid.New(), Name: "Flaky food"}
	good := nutrition.FoodItem{ID: uuid.New(), Name: "Good food"}

	s := &fakeStore{batches: [][]nutrition.FoodItem{{flaky, good}}}
	// One failed attempt on the flaky row, then success: 2 + 1 = 3 calls.
	e := &flakyEmbedder{failures: map[string]int{"Flaky food": 1}}
	rec := &fakeRecorder{}

	o := run(context.Background(), s, e, rec)

	require.Equal(t, 2, o.embedded)
	require.Len(t, rec.usages, 3, "every provider call must be metered, not just the successful ones")
	assert.Equal(t, []string{ai.OutcomeError, ai.OutcomeOK, ai.OutcomeOK},
		[]string{rec.usages[0].Outcome, rec.usages[1].Outcome, rec.usages[2].Outcome})
	for _, u := range rec.usages {
		assert.Equal(t, "embed", u.CallType, "these must land under call_type=embed")
		assert.Equal(t, "gemini-embedding-001", u.Model)
	}
}

// A metering failure must never cost an embedding. The vectors are the point;
// the accounting is not.
func TestRunKeepsEmbeddingWhenRecordingFails(t *testing.T) {
	row := nutrition.FoodItem{ID: uuid.New(), Name: "Good food"}
	s := &fakeStore{batches: [][]nutrition.FoodItem{{row}}}
	rec := &fakeRecorder{err: errors.New("billing: record: connection refused")}

	o := run(context.Background(), s, &flakyEmbedder{}, rec)

	assert.Equal(t, 1, o.embedded)
	assert.False(t, o.gaveUp)
	assert.Equal(t, 0, exitCode(o))
	assert.True(t, s.stored[row.ID])
}

// A Usage with no Provider is a call that never reached one. Recording it
// would pad ai_usage_events and kora_ai_calls_total with phantom calls.
func TestMeterSkipsUsageThatNeverReachedAProvider(t *testing.T) {
	rec := &fakeRecorder{}

	meter(context.Background(), rec, ai.Usage{}, ai.OutcomeOK)
	assert.Empty(t, rec.usages, "a zero Usage is a call that never happened")

	meter(context.Background(), rec, ai.Usage{Provider: "gemini", CallType: "embed"}, ai.OutcomeOK)
	assert.Len(t, rec.usages, 1)
}

func TestExitCode(t *testing.T) {
	tests := []struct {
		name string
		o    outcome
		want int
	}{
		// The two green shapes. Nothing-to-do is the steady state: this Job
		// runs on every ArgoCD sync and almost always finds an empty queue.
		{name: "nothing to do is success", o: outcome{}, want: 0},
		{name: "all embedded is success", o: outcome{embedded: 10}, want: 0},
		// Draining the queue is what makes a run complete. A row that could
		// not be embedded but did not stop the run is reported in the log and
		// in kora_food_index_missing, not in the exit code.
		{
			name: "drained the queue despite a failed row is success",
			o:    outcome{embedded: 10, failed: 1},
			want: 0,
		},
		// The kora#97 signature: a run that stopped early must be red no
		// matter how much it embedded on the way.
		{name: "gave up having embedded nothing is a failure", o: outcome{failed: 5, gaveUp: true}, want: 1},
		{name: "gave up after real progress is still a failure", o: outcome{embedded: 999, failed: 1, gaveUp: true}, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, exitCode(tt.o))
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
		name           string
		gatewayEnabled bool
		vertexProject  string
		geminiAPIKey   string
		want           embedBackend
	}{
		{name: "nothing configured", want: backendNone},
		{name: "api key only falls back to gemini", geminiAPIKey: "key", want: backendGemini},
		{name: "vertex only", vertexProject: "tesseracthub-480811", want: backendVertex},
		{name: "gateway only", gatewayEnabled: true, want: backendGateway},
		{
			name:           "gateway wins over legacy direct credentials",
			gatewayEnabled: true,
			vertexProject:  "tesseracthub-480811",
			geminiAPIKey:   "key",
			want:           backendGateway,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, chooseBackend(tt.gatewayEnabled, tt.vertexProject, tt.geminiAPIKey))
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

func (e *countingEmbedder) Embed(_ context.Context, _ string) ([]float32, ai.Usage, error) {
	e.calls++
	return nil, ai.Usage{Provider: "gemini", Model: "gemini-embedding-001", CallType: "embed"}, e.err
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
			vec, err := embedWithRetry(context.Background(), e, nil, "Some food")
			require.Error(t, err)
			assert.Nil(t, vec)
			assert.Equal(t, tt.wantAttempts, e.calls)
		})
	}
}
