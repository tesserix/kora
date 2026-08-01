package main

import (
	"context"
	"flag"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/nutrition/ingest"
)

func main() {
	afcd := flag.String("afcd", "data/food/afcd_staples.json", "AFCD staples JSON path")
	usda := flag.String("usda", "data/food/usda_common.json", "USDA common foods JSON path")
	backfill := flag.Bool("backfill-normalized", false, "recompute normalized_name for all rows")
	flag.Parse()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("ingest: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	repo := nutrition.NewRepository(db)
	ctx := context.Background()

	n, err := ingest.Run(ctx, repo, map[string]string{
		*afcd: nutrition.ProvenanceAFCD,
		*usda: nutrition.ProvenanceUSDA,
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ingest: inserted %d food items", n)

	if *backfill {
		u, err := repo.BackfillNormalizedNames(ctx)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("ingest: backfilled %d normalized names", u)
	}
}
