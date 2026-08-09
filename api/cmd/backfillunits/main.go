// Command backfillunits repairs the unit metadata on food_items rows written
// before migration 000026.
//
// It does two things:
//
//  1. serving_units — populated by parsing the serving_desc text the row
//     already carries, falling back to the curated table keyed on the food's
//     name. A row that already has units is never touched.
//  2. base_unit — corrected for OpenFoodFacts-provenance rows by re-fetching
//     the product and reading its true serving_quantity_unit. Without this a
//     drink stays base_unit = 'g' forever: nutrition.ResolveBarcode
//     short-circuits on a local hit, so no amount of re-scanning refreshes a
//     cached row, and every millilitre the user enters is filed as a gram.
//
// Idempotent by construction: nothing is rewritten unless it would actually
// change, so the job is safe to re-run. An OFF fetch that fails is logged and
// skipped — one unreachable product never fails the whole job.
//
// Run with -dry-run first. This job has never been run against production and
// touches thousands of rows; the dry run reports exactly what it would write,
// including how many serving_units came from a row's own label versus the
// curated name table, and a sample of the latter.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"log/slog"
	"os"
	"time"

	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

const batchSize = 500

// offPause spaces out OpenFoodFacts requests. OFF asks API clients to stay
// well under a request per second; the row count here is small (only
// off-provenance rows with a barcode are fetched at all) so a flat pause is
// enough and needs no token bucket.
const offPause = 1200 * time.Millisecond

// fallbackSampleLimit caps how many curated-table matches a dry run prints.
// The point is to make the guesses inspectable, not to dump the table.
const fallbackSampleLimit = 25

// Sources of a serving_units payload, reported separately by a dry run: a
// row's own label is evidence, the curated name table is a category-level
// guess and is the one a reviewer needs to eyeball.
const (
	sourceParse    = "parse"
	sourceFallback = "fallback"
)

// unitPlan is the serving_units payload a single row would receive, and where
// the figures came from.
type unitPlan struct {
	Encoded json.RawMessage
	Source  string
}

// backfillItem computes the serving_units payload for a single food item,
// or reports false when the row should be left untouched.
func backfillItem(item nutrition.FoodItem) (unitPlan, bool) {
	// Never clobber units a row already has — those came from OFF or an admin
	// and are better evidence than a re-parse of the description text.
	if len(item.ServingUnits) > 0 && string(item.ServingUnits) != "[]" && string(item.ServingUnits) != "null" {
		return unitPlan{}, false
	}
	// The row's own label first — it is always better evidence than a
	// category-level guess. Only when it yields nothing do we fall back to the
	// curated table, and when that is empty too the food simply has no named
	// serving and the client uses raw base-unit entry.
	source := sourceParse
	parsed, err := units.Parse(item.ServingDesc)
	if err != nil {
		source = sourceFallback
		parsed = units.Fallback(item.Name)
		if len(parsed) == 0 {
			return unitPlan{}, false
		}
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return unitPlan{}, false
	}
	return unitPlan{Encoded: encoded, Source: source}, true
}

// needsBaseUnitRefetch reports whether a row's base_unit can only be settled
// by asking OpenFoodFacts again. Only OFF-provenance rows with a barcode
// qualify: every other row's base unit came from a seed or an admin, and
// there is no third party to ask.
func needsBaseUnitRefetch(item nutrition.FoodItem) bool {
	return item.Provenance == nutrition.ProvenanceOFF && item.Barcode != nil && *item.Barcode != ""
}

// baseUnitPlan reports the corrected base unit for a row given the freshly
// fetched product, or ok=false when nothing should be written. A row whose
// base_unit is already right is left alone, so re-running the job is a no-op.
func baseUnitPlan(item nutrition.FoodItem, fetched *nutrition.FoodItem) (string, bool) {
	if fetched == nil || fetched.BaseUnit == "" {
		return "", false
	}
	if fetched.BaseUnit == item.BaseUnit {
		return "", false
	}
	return fetched.BaseUnit, true
}

// stats is what one pass of the job did (or, in a dry run, would have done).
type stats struct {
	UnitsWritten    int
	Skipped         int
	FromParse       int
	FromFallback    int
	FallbackSamples []string
	BaseUnitWritten int
	BaseUnitFetched int
	BaseUnitFailed  int
}

type options struct {
	DryRun bool
	// OFF is the client used to re-read base_unit for OFF-provenance rows.
	// Nil disables the base_unit half entirely (used by tests that only
	// exercise the serving_units half).
	OFF nutrition.OFFClient
	// Pause between OFF requests. Zero in tests.
	Pause time.Duration
}

func main() {
	dryRun := flag.Bool("dry-run", false, "report what would be written without writing anything")
	flag.Parse()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("backfillunits: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}

	off := nutrition.NewHTTPOFFClient()
	result, err := run(context.Background(), db, options{DryRun: *dryRun, OFF: off, Pause: offPause})
	if err != nil {
		log.Fatal(err)
	}
	report(*dryRun, result)
}

func report(dryRun bool, s stats) {
	slog.Info("backfillunits: complete",
		"dry_run", dryRun,
		"serving_units_rows", s.UnitsWritten,
		"from_label_parse", s.FromParse,
		"from_curated_table", s.FromFallback,
		"skipped", s.Skipped,
		"base_unit_rows", s.BaseUnitWritten,
		"off_fetched", s.BaseUnitFetched,
		"off_failed", s.BaseUnitFailed,
	)
	for _, sample := range s.FallbackSamples {
		slog.Info("backfillunits: curated-table guess", "food", sample)
	}
}

// run streams food_items in batches, repairing serving_units and (for OFF
// rows) base_unit where possible, and returns what it did. With
// options.DryRun set it computes everything and writes nothing.
func run(ctx context.Context, db *gorm.DB, opts options) (stats, error) {
	var s stats
	var batch []nutrition.FoodItem
	result := db.WithContext(ctx).FindInBatches(&batch, batchSize, func(tx *gorm.DB, batchNum int) error {
		for _, item := range batch {
			changes := map[string]any{}

			if plan, ok := backfillItem(item); ok {
				changes["serving_units"] = plan.Encoded
				s.UnitsWritten++
				if plan.Source == sourceFallback {
					s.FromFallback++
					if len(s.FallbackSamples) < fallbackSampleLimit {
						s.FallbackSamples = append(s.FallbackSamples, item.Name)
					}
				} else {
					s.FromParse++
				}
			} else {
				s.Skipped++
			}

			if opts.OFF != nil && needsBaseUnitRefetch(item) {
				if base, ok := s.refetchBaseUnit(ctx, opts, item); ok {
					changes["base_unit"] = base
					s.BaseUnitWritten++
				}
			}

			if len(changes) == 0 || opts.DryRun {
				continue
			}
			if err := tx.Model(&nutrition.FoodItem{}).
				Where("id = ?", item.ID).
				Updates(changes).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if result.Error != nil {
		return s, result.Error
	}
	return s, nil
}

// refetchBaseUnit asks OpenFoodFacts for the row's product and reports the
// corrected base unit. A fetch failure is counted and swallowed: one
// unreachable product must never fail a job that spans thousands of rows.
func (s *stats) refetchBaseUnit(ctx context.Context, opts options, item nutrition.FoodItem) (string, bool) {
	if opts.Pause > 0 {
		select {
		case <-ctx.Done():
			return "", false
		case <-time.After(opts.Pause):
		}
	}
	s.BaseUnitFetched++
	fetched, err := opts.OFF.Fetch(ctx, *item.Barcode)
	if err != nil {
		s.BaseUnitFailed++
		slog.WarnContext(ctx, "backfillunits: OFF fetch failed, leaving base_unit alone",
			"error", err, "barcode", *item.Barcode, "food", item.Name)
		return "", false
	}
	if fetched == nil {
		s.BaseUnitFailed++
		slog.WarnContext(ctx, "backfillunits: OFF no longer knows this product",
			"barcode", *item.Barcode, "food", item.Name)
		return "", false
	}
	return baseUnitPlan(item, fetched)
}
