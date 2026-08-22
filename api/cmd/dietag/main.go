// Command dietag backfills diet_tags on food_items rows written before
// migration 000043.
//
// Every write path derives tags now (the model's BeforeSave hook on inserts,
// diffForUpdate and admin's UpdateFood on renames), so this job exists only
// for the rows already in the index — without it a user's "no beef" rule
// filters nothing, because no row carries contains-beef yet.
//
// Idempotent by construction: a row is rewritten only when its stored tags
// differ from what its own name and brand now derive, so re-running is a
// no-op and a taxonomy change is picked up by the next run.
//
// Run with -dry-run first: the dry run reports what it would write and names
// a sample, which a bare count never does.
package main

import (
	"context"
	"flag"
	"log"
	"log/slog"
	"os"
	"sort"
	"strings"

	"github.com/lib/pq"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/diet"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const batchSize = 500

// sampleLimit caps how many rows a run names, so a dry run stays readable
// across an index of tens of thousands of rows.
const sampleLimit = 40

type stats struct {
	Scanned   int
	Tagged    int
	Unchanged int
	// Samples name "Beef mince → contains-beef" transitions. Capped.
	Samples []string
}

func main() {
	dryRun := flag.Bool("dry-run", false, "report what would be written without writing anything")
	flag.Parse()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("dietag: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}

	result, err := run(context.Background(), db, *dryRun)
	if err != nil {
		log.Fatal(err)
	}
	slog.Info("dietag: complete",
		"dry_run", *dryRun, "scanned", result.Scanned,
		"tagged", result.Tagged, "unchanged", result.Unchanged)
	for _, sample := range result.Samples {
		slog.Info("dietag: tag change", "change", sample)
	}
}

// run streams every food row in batches and rewrites diet_tags where the
// stored value disagrees with the row's own name and brand.
//
// Soft-deleted rows are included on purpose: a retired row can be restored by
// an admin, and one that came back untagged would be invisible to the exclusion
// query while being perfectly visible to search.
func run(ctx context.Context, db *gorm.DB, dryRun bool) (stats, error) {
	var s stats
	var batch []nutrition.FoodItem
	result := db.WithContext(ctx).Model(&nutrition.FoodItem{}).
		Unscoped().
		FindInBatches(&batch, batchSize, func(tx *gorm.DB, _ int) error {
			for _, item := range batch {
				s.Scanned++
				tags := diet.TagsFor(item.Name, item.Brand, nil)
				if sameTags(item.DietTags, tags) {
					s.Unchanged++
					continue
				}
				s.Tagged++
				if len(s.Samples) < sampleLimit {
					s.Samples = append(s.Samples,
						item.Name+" → ["+strings.Join(tags, " ")+"]")
				}
				if dryRun {
					continue
				}
				// UpdateColumn, not Update: retagging is a data repair, not an
				// edit the user made, and it must not move updated_at and so
				// invalidate every client's cached row.
				if err := tx.Model(&nutrition.FoodItem{}).
					Where("id = ?", item.ID).
					UpdateColumn("diet_tags", pq.StringArray(tags)).Error; err != nil {
					return err
				}
			}
			return nil
		})
	return s, result.Error
}

// sameTags compares two tag sets by content, so a difference in stored order
// never causes a pointless rewrite.
func sameTags(stored pq.StringArray, derived []string) bool {
	if len(stored) != len(derived) {
		return false
	}
	a := append([]string(nil), stored...)
	b := append([]string(nil), derived...)
	sort.Strings(a)
	sort.Strings(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
