# Embed at Ingest and Loud Embed Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a newly scanned product its embedding straight away, and make `cmd/embed` fail loudly instead of reporting success when it embedded nothing.

**Architecture:** `nutrition` declares its own narrow `Embedder` interface (it cannot import `ai`, which imports it), injected via a functional option and wired with an adapter in `main.go`. After the OpenFoodFacts insert path stores a new row, the embed runs in a background goroutine; failure leaves the column NULL so `cmd/embed` still picks it up. `cmd/embed` gains retries, a failure count, and a non-zero exit.

**Tech Stack:** Go 1.26, GORM, testify

**Spec:** `docs/superpowers/specs/2026-08-11-kora-embed-at-ingest-design.md`

## Global Constraints

- **`nutrition` must NOT import `ai`.** `ai` imports `nutrition` (the resolver holds a `nutrition.Repository`), so the reverse is an import cycle. That is why `Embedder` is declared locally in `nutrition`.
- **A nil `Embedder` is valid and means "do not embed."** Every existing construction site must keep working untouched.
- **Ingest-time embedding is an OPTIMISATION; `cmd/embed` is the guarantee.** A failed ingest embed logs and leaves `embedding` NULL so the row stays in `RowsMissingEmbedding` for the next pass. Put **no retry logic on the ingest path** — that would duplicate Task 2.
- The ingest goroutine must use `context.WithTimeout(context.Background(), …)`, **never the request context**, which is cancelled as soon as the scan response is written.
- A scan must never fail because an embedding did.
- `cmd/embed` retries: **3 attempts, exponential backoff starting at 500ms.**
- **`cmd/embed` keeps exiting 0 when `GEMINI_API_KEY` is absent** — deliberate degradation, not failure.
- Go tests table-driven with testify, run from `api/` with `-p 1` (local Postgres has a low connection cap).
- Commits: conventional, **single-line**, no signature or attribution.

---

### Task 1: Embed a newly ingested food

**Files:**
- Modify: `api/internal/nutrition/repository.go:14-21` (Repository struct, NewRepository)
- Modify: `api/internal/nutrition/barcode.go:187-219` (ResolveBarcode)
- Modify: `api/cmd/api/main.go:236,263` (wire the adapter)
- Test: `api/internal/nutrition/barcode_test.go`

**Interfaces:**
- Consumes: `Repository.Insert`, `Repository.SetEmbedding(ctx, id uuid.UUID, vec []float32) error` (both already on disk)
- Produces:
  - `type Embedder interface { Embed(ctx context.Context, text string) ([]float32, error) }`
  - `func (r Repository) WithEmbedder(e Embedder) Repository`

- [ ] **Step 1: Write the failing test**

Add to `api/internal/nutrition/barcode_test.go`, following the OFF stub-server pattern already in that file:

```go
// fakeEmbedder records calls and returns a canned vector or error.
type fakeEmbedder struct {
	mu     sync.Mutex
	calls  []string
	vec    []float32
	err    error
	called chan struct{} // closed after the first call, so tests can await the goroutine
}

func (f *fakeEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	f.mu.Lock()
	f.calls = append(f.calls, text)
	f.mu.Unlock()
	select {
	case <-f.called:
	default:
		close(f.called)
	}
	return f.vec, f.err
}

func TestResolveBarcodeEmbedsNewlyInsertedFood(t *testing.T) {
	db := testDB(t)
	emb := &fakeEmbedder{vec: make([]float32, 768), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)

	srv := offStubServer(t, offProduct{ProductName: "Test drink", EnergyKcal100g: 42, ServingQuantity: 250, ServingQuantityUnit: "ml"})
	defer srv.Close()

	item, found, err := repo.ResolveBarcode(context.Background(), NewHTTPOFFClient(srv.URL), "9310232956596")
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)

	// The embed runs in a goroutine, so wait for it rather than sleeping.
	select {
	case <-emb.called:
	case <-time.After(2 * time.Second):
		t.Fatal("embedder was never called")
	}

	require.Eventually(t, func() bool {
		var stored FoodItem
		if err := db.First(&stored, "id = ?", item.ID).Error; err != nil {
			return false
		}
		return stored.Embedding != nil
	}, 2*time.Second, 20*time.Millisecond, "embedding was never stored")
}

func TestResolveBarcodeLeavesEmbeddingNullWhenEmbedFails(t *testing.T) {
	// THE LOAD-BEARING TEST. A failed ingest embed must leave the column NULL
	// so the row stays in RowsMissingEmbedding and cmd/embed retries it. If
	// this ever stores a zero vector or otherwise marks the row done, the
	// whole async design silently loses rows.
	db := testDB(t)
	emb := &fakeEmbedder{err: errors.New("boom"), called: make(chan struct{})}
	repo := NewRepository(db).WithEmbedder(emb)

	srv := offStubServer(t, offProduct{ProductName: "Test drink 2", EnergyKcal100g: 42})
	defer srv.Close()

	item, found, err := repo.ResolveBarcode(context.Background(), NewHTTPOFFClient(srv.URL), "9300605158641")
	// The SCAN must still succeed — a failed embedding is not the user's problem.
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)

	select {
	case <-emb.called:
	case <-time.After(2 * time.Second):
		t.Fatal("embedder was never called")
	}

	// Give the goroutine room to (incorrectly) write, then assert it did not.
	time.Sleep(100 * time.Millisecond)
	var stored FoodItem
	require.NoError(t, db.First(&stored, "id = ?", item.ID).Error)
	assert.Nil(t, stored.Embedding)
}

func TestResolveBarcodeWithoutEmbedderInsertsNormally(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db) // no WithEmbedder — nil Embedder

	srv := offStubServer(t, offProduct{ProductName: "Test drink 3", EnergyKcal100g: 42})
	defer srv.Close()

	item, found, err := repo.ResolveBarcode(context.Background(), NewHTTPOFFClient(srv.URL), "9300605158642")
	require.NoError(t, err)
	require.True(t, found)
	require.NotNil(t, item)
}
```

Adapt `testDB`, `offStubServer`, `offProduct` and the OFF client constructor to the names actually in that package — read `barcode_test.go` and `repository_test.go` first. Do not restructure existing tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run from `api/`: `go test ./internal/nutrition/ -run TestResolveBarcode -count=1 -p 1 -v`
Expected: FAIL — `WithEmbedder` is undefined.

- [ ] **Step 3: Implement**

In `api/internal/nutrition/repository.go`, add the interface and the option, and the field on the struct:

```go
// Embedder generates a vector for a food name. Declared HERE rather than
// imported from package ai because ai imports nutrition — taking the
// dependency the other way would be an import cycle. cmd/api adapts the real
// provider (which also returns a Usage) to this narrower shape.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

type Repository struct {
	db       *gorm.DB
	embedder Embedder
}

// WithEmbedder returns a copy of the repository that embeds a food as soon as
// it is ingested. A nil embedder (the default) simply skips that step, so every
// existing construction site keeps working unchanged.
func (r Repository) WithEmbedder(e Embedder) Repository {
	r.embedder = e
	return r
}
```

In `api/internal/nutrition/barcode.go`, immediately before the final `return &cached, true, nil` of `ResolveBarcode`, kick off the embed:

```go
	r.embedAsync(cached.ID, cached.Name)
	return &cached, true, nil
```

and add the helper to the same file:

```go
// embedAsync fills a freshly ingested food's embedding in the background.
//
// Deliberately fire-and-forget with its own context: the caller's context is
// cancelled the moment the scan response is written, and a scan must never
// fail — or wait — because an embedding did.
//
// On failure it logs and leaves the column NULL, which puts the row straight
// back into RowsMissingEmbedding for the next cmd/embed pass. That is the
// whole safety argument for doing this asynchronously, and it is why there is
// no retry here: cmd/embed already retries properly.
func (r Repository) embedAsync(id uuid.UUID, name string) {
	if r.embedder == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		vec, err := r.embedder.Embed(ctx, name)
		if err != nil {
			slog.WarnContext(ctx, "nutrition: ingest-time embed failed; row left for cmd/embed",
				"error", err, "food_item_id", id, "name", name)
			return
		}
		if err := r.SetEmbedding(ctx, id, vec); err != nil {
			slog.WarnContext(ctx, "nutrition: storing ingest-time embedding failed; row left for cmd/embed",
				"error", err, "food_item_id", id)
		}
	}()
}
```

Add `log/slog` and `time` to that file's imports.

Finally, wire it in `api/cmd/api/main.go`. The Gemini provider is constructed at `:236` and the repository at `:263`; the provider's `Embed` returns `([]float32, ai.Usage, error)`, so adapt it:

```go
// geminiEmbedder adapts the AI provider's three-value Embed to the narrower
// shape nutrition.Embedder needs (nutrition cannot import ai — see the
// interface's own comment).
type geminiEmbedder struct{ p providers.GeminiProvider }

func (g geminiEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	vec, _, err := g.p.Embed(ctx, text)
	return vec, err
}
```

and change the repository construction to `foods := nutrition.NewRepository(db).WithEmbedder(geminiEmbedder{p: gemini})`. If `gemini` is nil or unusable when no key is configured, guard the `WithEmbedder` call so the repository is left with a nil embedder rather than a panicking one — read the surrounding code at `:236` to see how a missing key is handled today and match it.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go build ./... && go vet ./... && go test ./internal/nutrition/ -count=1 -p 1`
Expected: PASS, including every pre-existing nutrition test.

- [ ] **Step 5: Commit**

```bash
git add api/internal/nutrition/ api/cmd/api/main.go
git commit -m "feat(api): embed a food as soon as a barcode scan ingests it"
```

---

### Task 2: `cmd/embed` retries, counts and exits non-zero

**Files:**
- Modify: `api/cmd/embed/main.go` (whole file)
- Test: `api/cmd/embed/main_test.go`

**Interfaces:**
- Consumes: `nutrition.Repository.RowsMissingEmbedding(ctx, limit) ([]FoodItem, error)`, `SetEmbedding(ctx, id, vec) error` (both on disk)
- Produces:
  - `type embedder interface { Embed(ctx context.Context, text string) ([]float32, error) }`
  - `type store interface { RowsMissingEmbedding(context.Context, int) ([]nutrition.FoodItem, error); SetEmbedding(context.Context, uuid.UUID, []float32) error }`
  - `func run(ctx context.Context, s store, e embedder) (embedded int, failed int)`
  - `func exitCode(embedded, failed int) int`

- [ ] **Step 1: Write the failing test**

Create `api/cmd/embed/main_test.go`:

```go
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
	failures map[string]int
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
		name              string
		embedded, failed  int
		want              int
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `api/`: `go test ./cmd/embed/ -count=1 -v`
Expected: FAIL — `run` and `exitCode` are undefined.

- [ ] **Step 3: Implement**

Restructure `api/cmd/embed/main.go` so the work is testable, mirroring how `cmd/backfillunits` separates its core from `main`:

```go
const (
	batchSize     = 100
	embedAttempts = 3
)

// A var, not a const, purely so tests can zero it. With the production value a
// single persistently-failing row costs 1.5s of sleeping, which would make the
// retry tests slow for no benefit — they are asserting the retry COUNT, not
// the wall-clock delay.
var embedBaseDelay = 500 * time.Millisecond

type embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

type store interface {
	RowsMissingEmbedding(ctx context.Context, limit int) ([]nutrition.FoodItem, error)
	SetEmbedding(ctx context.Context, id uuid.UUID, vec []float32) error
}

// embedWithRetry absorbs a transient provider blip. The 2026-08-02 run lost 69
// rows to exactly that and reported success. Three attempts, not more: a
// sustained outage is already handled by the whole-batch bail-out below, and
// retrying every row five times against a dead provider only delays the same
// answer.
func embedWithRetry(ctx context.Context, e embedder, name string) ([]float32, error) {
	var lastErr error
	delay := embedBaseDelay
	for attempt := 1; attempt <= embedAttempts; attempt++ {
		vec, err := e.Embed(ctx, name)
		if err == nil {
			return vec, nil
		}
		lastErr = err
		if attempt < embedAttempts {
			time.Sleep(delay)
			delay *= 2
		}
	}
	return nil, lastErr
}

// exitCode maps a run's outcome to a process exit code. ANY failure is a
// non-zero exit: the seed Job chains seed && ingest && embed, so this is what
// turns a partial embed red in ArgoCD instead of letting it read as healthy.
func exitCode(embedded, failed int) int {
	if failed > 0 {
		return 1
	}
	return 0
}

func run(ctx context.Context, s store, e embedder) (embedded int, failed int) {
	for {
		rows, err := s.RowsMissingEmbedding(ctx, batchSize)
		if err != nil {
			log.Printf("cmd/embed: fetch rows: %v", err)
			return embedded, failed + 1
		}
		if len(rows) == 0 {
			return embedded, failed
		}

		succeeded := 0
		for _, row := range rows {
			vec, err := embedWithRetry(ctx, e, row.Name)
			if err != nil {
				log.Printf("cmd/embed: embed %q (%s): %v", row.Name, row.ID, err)
				failed++
				continue
			}
			if err := s.SetEmbedding(ctx, row.ID, vec); err != nil {
				log.Printf("cmd/embed: set embedding %q (%s): %v", row.Name, row.ID, err)
				failed++
				continue
			}
			embedded++
			succeeded++
		}

		// A batch where nothing succeeded would return the same rows forever —
		// they are never marked done. Stop, and let the non-zero exit report it.
		if succeeded == 0 {
			log.Printf("cmd/embed: entire batch of %d rows failed to embed; stopping", len(rows))
			return embedded, failed
		}
	}
}
```

`main` becomes the shell: keep the existing `DATABASE_URL` check, keep the existing **exit 0 when `GEMINI_API_KEY` is empty** (deliberate degradation — do not change it), connect, construct the provider and repository, then:

```go
	embedded, failed := run(ctx, repo, provider)
	log.Printf("cmd/embed: embedded %d food items, failed %d", embedded, failed)
	os.Exit(exitCode(embedded, failed))
```

Note the log line now reports **both** numbers. Reporting only successes is what made "embedded 0" indistinguishable from a healthy run.

The real `providers.GeminiProvider.Embed` returns three values, so wrap it in a tiny adapter in this file the same way `cmd/api` does, or define the local `embedder` interface to match and adapt at the call site — either is fine, but say which you chose in your report.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go build ./... && go vet ./... && go test ./cmd/embed/ -count=1`
Expected: PASS, all three test functions.

- [ ] **Step 5: Commit**

```bash
git add api/cmd/embed/
git commit -m "feat(api): retry embeds and exit non-zero when any row fails"
```

---

## Verification

From `api/`:

```bash
go build ./... && go vet ./... && go test ./... -count=1 -p 1
```

Then, against the cluster (both are safe — the job is idempotent and the index is currently complete):

1. Confirm the index is still whole:
   `kubectl exec -n global global-postgres-1 -- psql -U postgres -d kora_db -tAc "select count(*)-count(embedding) from food_items where deleted_at is null;"`
   Expect `0`.
2. After deploying, scan a barcode Kora has never seen, then re-run that query. Expect it to stay `0` — the new row should arrive already embedded, rather than adding one to the missing count.
