// Command embed backfills the food_items.embedding column so the nutrition
// resolver's embedding tier (Resolve's MatchEmbedding path) has vectors to
// search. It requires GEMINI_API_KEY; without one it logs and exits 0 rather
// than crashing, since the rest of the engine builds/tests without keys.
package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/google/uuid"

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
// two-value embedder interface run depends on.
type geminiEmbedder struct {
	provider providers.GeminiProvider
}

func (g geminiEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	vec, _, err := g.provider.Embed(ctx, text)
	return vec, err
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("cmd/embed: DATABASE_URL required")
	}

	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		log.Println("cmd/embed: GEMINI_API_KEY required to generate embeddings; skipping")
		os.Exit(0)
	}

	ctx := context.Background()

	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	repo := nutrition.NewRepository(db)

	provider, err := providers.NewGeminiProvider(ctx, apiKey)
	if err != nil {
		log.Fatal(err)
	}

	embedded, failed := run(ctx, repo, geminiEmbedder{provider: provider})
	log.Printf("cmd/embed: embedded %d food items, failed %d", embedded, failed)
	os.Exit(exitCode(embedded, failed))
}

// embedWithRetry absorbs a transient provider blip. The 2026-08-02 run lost
// 69 rows to exactly that and reported success. Three attempts, not more: a
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
		// they are never marked done. Stop, and let the non-zero exit report it.
		if succeeded == 0 {
			log.Printf("cmd/embed: entire batch of %d rows failed to embed; stopping", len(rows))
			return embedded, failed
		}
	}
}
