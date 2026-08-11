package main

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"

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

// failNTimes fails the first n calls for a given name, then succeeds.
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

func TestExitCode(t *testing.T) {
	tests := []struct {
		name             string
		embedded, failed int
		want             int
	}{
		{name: "nothing to do is success", embedded: 0, failed: 0, want: 0},
		{name: "all embedded is success", embedded: 10, failed: 0, want: 0},
		// The case that made 08-02 invisible: some work failed, so the Job
		// must go red even though other rows succeeded.
		{name: "any failure is a failure", embedded: 10, failed: 1, want: 1},
		{name: "total failure is a failure", embedded: 0, failed: 5, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, exitCode(tt.embedded, tt.failed))
		})
	}
}
