package nutrition

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// AddAlias records a correction alias mapping a user phrase to a food item.
// The alias is stored lower+trim to match idx_food_aliases_alias ON
// food_aliases (lower(alias)) and the alias tier in Resolve — NOT Normalize,
// which would strip punctuation/singularize and cause future lookups to miss.
// It is idempotent per (alias, food_item_id): a duplicate insert is skipped.
// A blank alias is a no-op.
func (r Repository) AddAlias(ctx context.Context, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" {
		return nil
	}
	var n int64
	if err := r.db.WithContext(ctx).
		Raw("SELECT count(*) FROM food_aliases WHERE lower(alias) = ? AND food_item_id = ?", key, foodItemID).
		Scan(&n).Error; err != nil {
		return fmt.Errorf("nutrition: add alias check: %w", err)
	}
	if n > 0 {
		return nil
	}
	if err := r.db.WithContext(ctx).
		Exec("INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", key, foodItemID).Error; err != nil {
		return fmt.Errorf("nutrition: add alias insert: %w", err)
	}
	return nil
}
