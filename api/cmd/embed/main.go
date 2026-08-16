// Command embed backfills the food_items.embedding column so the nutrition
// resolver's embedding tier (Resolve's MatchEmbedding path) has vectors to
// search.
//
// It needs an embedding backend, and picks one exactly the way cmd/api's
// buildResolveHandler does: VERTEX_PROJECT (with optional VERTEX_LOCATION)
// wins, GEMINI_API_KEY is the fallback. With neither it logs and exits 0
// rather than crashing, since the rest of the engine builds/tests without
// keys.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/genai"

	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const (
	// batchSize is how many missing-embedding rows are pulled per round trip.
	batchSize = 100
	// embedAttempts is how many times a single row's embed is tried before
	// counting it as failed.
	embedAttempts = 3
	// defaultVertexLocation matches config.Load's VERTEX_LOCATION default and
	// providers.NewVertexProvider's own fallback. It is spelled out here only
	// so the startup log reports the location actually used; see
	// NewVertexProvider for why "global" and not a region.
	defaultVertexLocation = "global"
)

// embedBaseDelay is the initial backoff between retry attempts, doubled each
// time. A var, not a const, purely so tests can zero it. With the production
// value a single persistently-failing row costs 1.5s of sleeping, which would
// make the retry tests slow for no benefit — they are asserting the retry
// COUNT, not the wall-clock delay.
var embedBaseDelay = 500 * time.Millisecond

// embedder is the subset of a provider's embedding capability cmd/embed
// needs. The real providers.GeminiProvider.Embed returns three values
// ([]float32, ai.Usage, error); geminiEmbedder below adapts it to this
// two-value shape so main can keep run's dependency small and testable.
type embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

// store is the subset of nutrition.Repository run needs.
type store interface {
	RowsMissingEmbedding(ctx context.Context, limit int) ([]nutrition.FoodItem, error)
	SetEmbedding(ctx context.Context, id uuid.UUID, vec []float32) error
}

// geminiEmbedder adapts providers.GeminiProvider's three-value Embed to the
// two-value embedder interface run depends on. It covers BOTH backends:
// NewVertexProvider returns the same GeminiProvider struct as
// NewGeminiProvider, differing only in the client's backend, so nothing below
// this line has to know which one was chosen.
type geminiEmbedder struct {
	provider providers.GeminiProvider
}

func (g geminiEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	vec, _, err := g.provider.Embed(ctx, text)
	return vec, err
}

// embedBackend names which provider main will construct.
type embedBackend int

const (
	// backendNone means nothing is configured — the run is skipped.
	backendNone embedBackend = iota
	backendVertex
	backendGemini
)

// chooseBackend applies the SAME precedence as cmd/api's buildResolveHandler:
// Vertex wins when configured, the API key is the fallback, and neither means
// disabled.
//
// The reason is stronger here than it is there. This command's whole job is
// bulk embedding, and the Gemini free tier — which is what a GEMINI_API_KEY
// from the billing-disabled kora-app-e6d38 project buys — caps embeddings at
// 1,000 per project per DAY, shared with the resolver's own embed calls. At
// ~15k rows that is a fortnight of backfill for a job that should take
// minutes, and it is the documented reason the index stalled at 607 of 5,669
// rows (kora#97). Vertex is authenticated by the workload's service account
// against a billing-enabled project, so it has neither the cap nor the key.
//
// The API-key path stays for local development, where there is no Workload
// Identity to authenticate against.
func chooseBackend(vertexProject, geminiAPIKey string) embedBackend {
	switch {
	case vertexProject != "":
		return backendVertex
	case geminiAPIKey != "":
		return backendGemini
	default:
		return backendNone
	}
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("cmd/embed: DATABASE_URL required")
	}

	vertexProject := os.Getenv("VERTEX_PROJECT")
	vertexLocation := os.Getenv("VERTEX_LOCATION")
	if vertexLocation == "" {
		vertexLocation = defaultVertexLocation
	}
	apiKey := os.Getenv("GEMINI_API_KEY")

	backend := chooseBackend(vertexProject, apiKey)
	if backend == backendNone {
		log.Println("cmd/embed: no embedding backend (no VERTEX_PROJECT and no GEMINI_API_KEY); skipping")
		os.Exit(0)
	}

	ctx := context.Background()

	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	repo := nutrition.NewRepository(db)

	var provider providers.GeminiProvider
	switch backend {
	case backendVertex:
		provider, err = providers.NewVertexProvider(ctx, vertexProject, vertexLocation)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("cmd/embed: vertex ai project=%s location=%s", vertexProject, vertexLocation)
	case backendGemini:
		provider, err = providers.NewGeminiProvider(ctx, apiKey)
		if err != nil {
			log.Fatal(err)
		}
		log.Println("cmd/embed: gemini api key")
	}

	embedded, failed := run(ctx, repo, geminiEmbedder{provider: provider})
	log.Printf("cmd/embed: embedded %d food items, failed %d", embedded, failed)
	os.Exit(exitCode(embedded, failed))
}

// isRateLimited reports whether err is the provider's rate-limit / quota
// rejection rather than a transient blip. The genai SDK surfaces every non-2xx
// response as a genai.APIError carrying the HTTP status in Code (see
// newAPIError in google.golang.org/genai/api_client.go), and
// providers.GeminiProvider.Embed wraps that error with %w, so errors.As
// reaches it through the wrapping.
//
// The message fallback is a deliberate backstop, not a guess: the embedder
// interface is provider-agnostic (an ai.Router-backed embedder can surface an
// OpenAI-compatible error instead), and any layer that stringifies the error
// before it reaches here would defeat errors.As. Matching the documented
// Gemini/HTTP vocabulary — 429, RESOURCE_EXHAUSTED, "rate limit", "quota" —
// is the best available signal in that case. A false positive costs one
// missed retry; a false negative costs three requests against the very quota
// that just rejected us.
func isRateLimited(err error) bool {
	if err == nil {
		return false
	}
	var apiErr genai.APIError
	if errors.As(err, &apiErr) &&
		(apiErr.Code == http.StatusTooManyRequests || strings.EqualFold(apiErr.Status, "RESOURCE_EXHAUSTED")) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "429") ||
		strings.Contains(msg, "resource_exhausted") ||
		strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "ratelimit") ||
		strings.Contains(msg, "too many requests") ||
		strings.Contains(msg, "quota")
}

// embedWithRetry absorbs a transient provider blip. The 2026-08-02 run lost
// 69 rows to exactly that and reported success. Three attempts, not more: a
// sustained outage is already handled by the whole-batch bail-out below, and
// retrying every row five times against a dead provider only delays the same
// answer.
//
// A rate-limit rejection is exempted from retrying entirely. The documented
// production failure is Gemini's free-tier ~100 req/min cap; retrying spends
// three requests per row against the quota whose exhaustion caused the
// failure, which makes the outage worse and deeper. Fail the row on the first
// 429 and let it stay in RowsMissingEmbedding for the next run.
func embedWithRetry(ctx context.Context, e embedder, name string) ([]float32, error) {
	var lastErr error
	delay := embedBaseDelay
	for attempt := 1; attempt <= embedAttempts; attempt++ {
		vec, err := e.Embed(ctx, name)
		if err == nil {
			return vec, nil
		}
		lastErr = err
		if isRateLimited(err) {
			return nil, err
		}
		if attempt < embedAttempts {
			time.Sleep(delay)
			delay *= 2
		}
	}
	return nil, lastErr
}

// exitCode maps a run's outcome to a process exit code. It is non-zero for
// exactly one shape: the run embedded NOTHING while rows were failing. That is
// the 2026-08-02 signature — a run that achieved nothing yet reported success,
// losing 69 rows silently.
//
// A run that embedded anything stays GREEN even with failures, and that is
// deliberate. cmd/embed runs chained as `seed && ingest && embed` in a Job with
// backoffLimit 5 and restartPolicy OnFailure, on every ArgoCD sync. Under an
// "any failure is red" rule:
//
//   - one permanently un-embeddable row — which sits at the head of
//     RowsMissingEmbedding forever, since that query is ORDER BY created_at —
//     red-lines every deploy from then on, and an alarm that is always on is
//     an alarm nobody reads; and
//   - a partial rate-limit failure red-lines a run that made real progress,
//     then re-runs the entire seed/ingest/embed chain up to six times, burning
//     the ~1000/day Gemini quota whose exhaustion caused the failure.
//
// Progress-means-green is safe because the slow-leak signal lives elsewhere,
// on a continuous gauge rather than a binary exit code: kora_food_index_missing
// (declared in internal/metrics/metrics.go, reported by
// internal/metrics/foodindex.go) publishes the number of rows still missing an
// embedding on every scrape. A backlog that only ever grows is visible there
// without making every deploy red.
func exitCode(embedded, failed int) int {
	if embedded == 0 && failed > 0 {
		return 1
	}
	return 0
}

// run streams food_items missing an embedding, embeds each with retry, and
// returns how many succeeded and how many failed permanently.
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
		// they are never marked done. Stop. Whether that is reported as a
		// failure is exitCode's call: it is only red if the whole run embedded
		// nothing, not merely this batch.
		if succeeded == 0 {
			log.Printf("cmd/embed: entire batch of %d rows failed to embed; stopping", len(rows))
			return embedded, failed
		}
	}
}
