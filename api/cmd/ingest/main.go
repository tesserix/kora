package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"path/filepath"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/nutrition/ingest"
)

func main() {
	// ONE directory, not a path per source.
	//
	// This used to be nine `-flag path` flags whose defaults were repo-relative
	// while the image mounts the data at /usr/local/share/kora/food — so the
	// kora-api seed Job in tesserix-k8s had to repeat all nine as absolute
	// paths, and a source added here without a matching line over there made
	// the Job exit 1 and crash-loop prod. That happened THREE times in one day
	// (kora#215's -ifct, then -ausnut, then -aliases), and the warning comment
	// written after the first did not prevent the second or third.
	//
	// Which files are read, and the provenance each is stamped with, now lives
	// in ingest.Sources. Adding a source is a line in that table plus the file;
	// the chart passes this directory and never needs to know. TestSourceFilesExist
	// fails CI if a declared file was never committed.
	foodDir := flag.String("food-dir", "data/food",
		"directory holding the food source JSON (image: /usr/local/share/kora/food)")
	backfill := flag.Bool("backfill-normalized", false, "recompute normalized_name for all rows")
	// MUST be run once against any index ingested before kora#212's USDA brand
	// extraction landed. The loader now emits ("FILET-O-FISH", "McDONALD'S")
	// where the stored row is ("McDONALD'S, FILET-O-FISH", ""), and ingest
	// matches on name+brand — so without this the next run inserts 310
	// duplicates instead of recognising them. Idempotent; a second run is a
	// no-op.
	backfillBrands := flag.Bool("backfill-usda-brands", false,
		"move brands USDA embedded in the name into the brand column, and retype those rows")
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

	// Runs BEFORE Run so the stored rows already match what the loader now
	// emits; the other order would insert the duplicates this exists to avoid.
	if *backfillBrands {
		u, err := repo.BackfillUSDAEmbeddedBrands(ctx)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("ingest: moved %d embedded USDA brands into the brand column", u)
	}

	n, err := ingest.Run(ctx, repo, ingest.Sources(*foodDir))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ingest: inserted %d food items", n)

	// After the load, so an alias can name a row this same run created.
	aliasPath := filepath.Join(*foodDir, ingest.AliasFile)
	aliasData, err := os.ReadFile(aliasPath)
	if err != nil {
		log.Fatalf("ingest: read aliases %s: %v", aliasPath, err)
	}
	var curatedAliases []nutrition.GlobalAlias
	if err := json.Unmarshal(aliasData, &curatedAliases); err != nil {
		log.Fatalf("ingest: parse aliases %s: %v", aliasPath, err)
	}
	appliedAliases, unresolved, err := repo.UpsertGlobalAliases(ctx, curatedAliases)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ingest: applied %d global aliases", appliedAliases)
	// Loud, not silent: an unresolved alias means the data file names a row
	// that no longer exists, which is a hand-curated mapping quietly rotting.
	for _, u := range unresolved {
		log.Printf("ingest: WARNING unresolved alias %s", u)
	}

	if *backfill {
		u, err := repo.BackfillNormalizedNames(ctx)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("ingest: backfilled %d normalized names", u)
	}
}
