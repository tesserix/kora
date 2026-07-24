// Command embed backfills the food_items.embedding column so the nutrition
// resolver's embedding tier (Resolve's MatchEmbedding path) has vectors to
// search. It requires GEMINI_API_KEY; without one it logs and exits 0 rather
// than crashing, since the rest of the engine builds/tests without keys.
package main

import (
	"context"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// batchSize is how many missing-embedding rows are pulled per round trip.
const batchSize = 100

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

	embedded := 0
	for {
		rows, err := repo.RowsMissingEmbedding(ctx, batchSize)
		if err != nil {
			log.Fatal(err)
		}
		if len(rows) == 0 {
			break
		}

		succeeded := 0
		for _, row := range rows {
			vec, _, err := provider.Embed(ctx, row.Name)
			if err != nil {
				log.Printf("cmd/embed: embed %q (%s): %v", row.Name, row.ID, err)
				continue
			}
			if err := repo.SetEmbedding(ctx, row.ID, vec); err != nil {
				log.Printf("cmd/embed: set embedding %q (%s): %v", row.Name, row.ID, err)
				continue
			}
			embedded++
			succeeded++
		}

		// If an entire batch failed, the failing rows will keep coming back
		// from RowsMissingEmbedding forever (they're never marked done) — bail
		// out instead of looping infinitely on a persistent error.
		if succeeded == 0 {
			log.Printf("cmd/embed: entire batch of %d rows failed to embed; stopping", len(rows))
			break
		}
	}

	log.Printf("cmd/embed: embedded %d food items", embedded)
}
