// Command backfillunits populates food_items.serving_units for rows written
// before migration 000026, by parsing the serving_desc text they already
// carry. Idempotent: a row that already has units is skipped, so re-running
// the job is safe and never overwrites a curated or OFF-sourced value.
package main

import (
	"context"
	"encoding/json"
	"log"
	"log/slog"
	"os"

	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

const batchSize = 500

// backfillItem computes the serving_units payload for a single food item,
// or reports false when the row should be left untouched.
func backfillItem(item nutrition.FoodItem) (json.RawMessage, bool) {
	// Never clobber units a row already has — those came from OFF or an admin
	// and are better evidence than a re-parse of the description text.
	if len(item.ServingUnits) > 0 && string(item.ServingUnits) != "[]" && string(item.ServingUnits) != "null" {
		return nil, false
	}
	// The row's own label first — it is always better evidence than a
	// category-level guess. Only when it yields nothing do we fall back to the
	// curated table, and when that is empty too the food simply has no named
	// serving and the client uses raw base-unit entry.
	parsed, err := units.Parse(item.ServingDesc)
	if err != nil {
		parsed = units.Fallback(item.Name)
		if len(parsed) == 0 {
			return nil, false
		}
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("backfillunits: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}

	updated, skipped, err := run(context.Background(), db)
	if err != nil {
		log.Fatal(err)
	}
	slog.Info("backfillunits: complete", "updated", updated, "skipped", skipped)
}

// run streams food_items in batches, backfilling serving_units where
// possible, and returns the total rows updated and skipped.
func run(ctx context.Context, db *gorm.DB) (updated, skipped int, err error) {
	var batch []nutrition.FoodItem
	result := db.WithContext(ctx).FindInBatches(&batch, batchSize, func(tx *gorm.DB, batchNum int) error {
		for _, item := range batch {
			encoded, ok := backfillItem(item)
			if !ok {
				skipped++
				continue
			}
			if err := tx.Model(&nutrition.FoodItem{}).
				Where("id = ?", item.ID).
				Update("serving_units", encoded).Error; err != nil {
				return err
			}
			updated++
		}
		return nil
	})
	if result.Error != nil {
		return updated, skipped, result.Error
	}
	return updated, skipped, nil
}
