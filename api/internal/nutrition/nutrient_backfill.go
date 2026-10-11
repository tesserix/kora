package nutrition

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

// BackfillNutrients fills missing measurements from the row's owning source.
func (r Repository) BackfillNutrients(ctx context.Context, items []FoodItem) (int, error) {
	updated := 0
	for _, item := range items {
		if err := item.Nutrients.Validate(); err != nil {
			return updated, err
		}
		changes := make(map[string]any)
		for column, value := range item.Nutrients.Values() {
			if value != nil {
				changes[column] = gorm.Expr("COALESCE("+column+", ?)", *value)
			}
		}
		if len(changes) == 0 {
			continue
		}
		q := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("provenance = ? AND deleted_at IS NULL", item.Provenance)
		if item.Barcode != nil && *item.Barcode != "" {
			q = q.Where("barcode = ?", *item.Barcode)
		} else {
			q = q.Where("name = ? AND brand = ?", item.Name, item.Brand)
		}
		missing := r.db.Where("1 = 0")
		for column, value := range item.Nutrients.Values() {
			if value != nil {
				missing = missing.Or(column + " IS NULL")
			}
		}
		result := q.Where(missing).Updates(changes)
		if result.Error != nil {
			return updated, fmt.Errorf("nutrition: backfill nutrients: %w", result.Error)
		}
		updated += int(result.RowsAffected)
	}
	return updated, nil
}
