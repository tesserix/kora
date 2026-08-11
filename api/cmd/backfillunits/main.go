// Command backfillunits repairs the unit metadata on food_items rows written
// before migration 000026.
//
// It does two things:
//
//  1. serving_units — populated by parsing the serving_desc text the row
//     already carries, and only that. A row that already has units is never
//     touched, and a row whose label yields nothing is left without a named
//     serving rather than given a guessed one.
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
// Run with -dry-run first. The dry run reports exactly what it would write.
//
// This command used to consult units.Fallback, a curated table keyed on words
// in the food's name, whenever the label would not parse. That table is gone,
// and this is the record of why. The 2026-08-11 production dry run planned 762
// serving_units writes, of which only 123 came from a row's own label; the
// other 639 came from the table, and 395 of those matched a keyword that was
// not the food's head noun at all. "Apples, dried, stewed, WITHOUT added
// sugar" took sugar's 200 g cup, fried chicken "with flour" took flour's 125 g
// cup, and "Alcoholic beverage, rice (sake)" took rice's 158 g cup despite
// being a liquid — the matcher read a keyword anywhere in the name and could
// not read negation, so a USDA-style compound name was routinely claimed by an
// ingredient it merely mentioned.
//
// Restricting it to head nouns was measured and rejected: 60 of the 244
// surviving rows (24%) were still wrong, "Pork sausage rice links" and
// "RICE-A-RONI" among them, before counting intra-category density spread
// (chickpea flour ~92 g/cup against the table's assumed 125 g). The upside was
// 244 of 7,900 rows. An absent conversion is recoverable by the user; a
// fabricated one silently corrupts every total that uses it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"
	"strings"
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

// baseUnitSampleLimit caps how many base_unit transitions a run names. ml → g
// downgrades bypass this cap entirely — see stats.BaseUnitDowngrades.
const baseUnitSampleLimit = 50

// sourceParse is the only provenance a serving_units payload can now have: the
// row's own label. The curated name table that used to supply a second,
// category-level source is gone — see the package comment.
const sourceParse = "parse"

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
	// The row's own label is the only evidence there is. When it yields nothing
	// the food simply has no named serving and the client uses raw base-unit
	// entry — the recoverable outcome, where a guessed density is not.
	parsed, err := units.Parse(item.ServingDesc)
	if err != nil {
		return unitPlan{}, false
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return unitPlan{}, false
	}
	return unitPlan{Encoded: encoded, Source: sourceParse}, true
}

// needsBaseUnitRefetch reports whether a row's base_unit can only be settled
// by asking OpenFoodFacts again. Only OFF-provenance rows with a barcode
// qualify: every other row's base unit came from a seed or an admin, and
// there is no third party to ask.
func needsBaseUnitRefetch(item nutrition.FoodItem) bool {
	return item.Provenance == nutrition.ProvenanceOFF && item.Barcode != nil && *item.Barcode != ""
}

// baseUnitPlan reports the corrected base unit for a row given the raw
// serving_quantity_unit OpenFoodFacts currently publishes, or ok=false when
// nothing should be written. A row whose base_unit is already right is left
// alone, so re-running the job is a no-op.
//
// The raw field is deliberately what this takes. nutrition.BaseUnitFor maps
// ANYTHING unrecognised — an absent unit included — onto "g", so a fetched
// FoodItem's BaseUnit can never be empty and "OFF no longer publishes a unit"
// is indistinguishable from "OFF says grams". Correcting on that would write g
// over a row that is already correctly ml, silently re-creating the very bug
// this job exists to fix. Absent evidence is not evidence of grams.
func baseUnitPlan(item nutrition.FoodItem, rawServingUnit string) (string, bool) {
	if strings.TrimSpace(rawServingUnit) == "" {
		return "", false
	}
	base := nutrition.BaseUnitFor(rawServingUnit)
	if base == item.BaseUnit {
		return "", false
	}
	return base, true
}

// stats is what one pass of the job did (or, in a dry run, would have done).
type stats struct {
	UnitsWritten    int
	Skipped         int
	FromParse       int
	BaseUnitWritten int
	BaseUnitFetched int
	BaseUnitFailed  int
	// BaseUnitAbsent counts rows OFF still knows but publishes no
	// serving_quantity_unit for. These are deliberately left alone.
	BaseUnitAbsent int
	// BaseUnitSamples names base_unit transitions ("Milk: g → ml") so a dry
	// run is inspectable rather than a bare count. Capped.
	BaseUnitSamples []string
	// BaseUnitDowngrades names every ml → g transition, uncapped. A drink
	// being relabelled a solid is the one change that must never slip past a
	// dry run unseen, and it should be vanishingly rare.
	BaseUnitDowngrades []string
}

type options struct {
	DryRun bool
	// OFF re-reads the RAW serving_quantity_unit for OFF-provenance rows.
	// Nil disables the base_unit half entirely (used by tests that only
	// exercise the serving_units half).
	OFF nutrition.ServingUnitFetcher
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
		"skipped", s.Skipped,
		"base_unit_rows", s.BaseUnitWritten,
		"off_fetched", s.BaseUnitFetched,
		"off_failed", s.BaseUnitFailed,
		"off_unit_absent", s.BaseUnitAbsent,
	)
	// A count alone makes a dry run unreviewable — the whole point is to see
	// WHICH rows change before thousands are rewritten.
	for _, sample := range s.BaseUnitSamples {
		slog.Info("backfillunits: base_unit change", "change", sample)
	}
	// Louder, and never truncated: relabelling a millilitre row as grams is
	// exactly the corruption this job was written to undo.
	for _, sample := range s.BaseUnitDowngrades {
		slog.Warn("backfillunits: base_unit DOWNGRADE ml → g, review before applying", "change", sample)
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
				s.FromParse++
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

// refetchBaseUnit asks OpenFoodFacts for the row's raw serving_quantity_unit
// and reports the corrected base unit. A fetch failure is counted and
// swallowed: one unreachable product must never fail a job that spans
// thousands of rows. So is an absent unit — with nothing published there is
// nothing to correct against, and defaulting would downgrade a correct row.
func (s *stats) refetchBaseUnit(ctx context.Context, opts options, item nutrition.FoodItem) (string, bool) {
	if opts.Pause > 0 {
		select {
		case <-ctx.Done():
			return "", false
		case <-time.After(opts.Pause):
		}
	}
	s.BaseUnitFetched++
	raw, found, err := opts.OFF.FetchServingUnit(ctx, *item.Barcode)
	if err != nil {
		s.BaseUnitFailed++
		slog.WarnContext(ctx, "backfillunits: OFF fetch failed, leaving base_unit alone",
			"error", err, "barcode", *item.Barcode, "food", item.Name)
		return "", false
	}
	if !found {
		s.BaseUnitFailed++
		slog.WarnContext(ctx, "backfillunits: OFF no longer knows this product",
			"barcode", *item.Barcode, "food", item.Name)
		return "", false
	}
	if strings.TrimSpace(raw) == "" {
		s.BaseUnitAbsent++
		slog.InfoContext(ctx, "backfillunits: OFF publishes no serving unit, leaving base_unit alone",
			"barcode", *item.Barcode, "food", item.Name, "base_unit", item.BaseUnit)
		return "", false
	}
	base, ok := baseUnitPlan(item, raw)
	if ok {
		s.recordBaseUnitChange(item, base)
	}
	return base, ok
}

// recordBaseUnitChange makes a transition inspectable by name, which a bare
// count never is.
func (s *stats) recordBaseUnitChange(item nutrition.FoodItem, to string) {
	change := fmt.Sprintf("%s (%s): %s → %s", item.Name, *item.Barcode, item.BaseUnit, to)
	if item.BaseUnit == "ml" && to == "g" {
		s.BaseUnitDowngrades = append(s.BaseUnitDowngrades, change)
		return
	}
	if len(s.BaseUnitSamples) < baseUnitSampleLimit {
		s.BaseUnitSamples = append(s.BaseUnitSamples, change)
	}
}
