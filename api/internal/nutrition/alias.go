package nutrition

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// aliasOwner converts a user id into the value stored in food_aliases.user_id:
// a real id for a personal alias, SQL NULL (curated/global) for uuid.Nil.
func aliasOwner(userID uuid.UUID) any {
	if userID == uuid.Nil {
		return nil
	}
	return userID
}

// AddAlias records a correction alias mapping a user phrase to a food item,
// scoped to userID. uuid.Nil writes a curated/global alias.
//
// The alias is stored lower+trim to match idx_food_aliases_user_alias ON
// food_aliases (user_id, lower(alias)) and the alias tier in Resolve — NOT
// Normalize, which would strip punctuation/singularize and cause future
// lookups to miss. A blank alias is a no-op.
//
// Idempotent per (user_id, lower(alias), food_item_id) via ON CONFLICT against
// idx_food_aliases_unique — a real constraint rather than the check-then-insert
// this replaced, which could double-write under concurrency — but ONLY for
// personal aliases (non-NULL user_id). Postgres treats NULL as DISTINCT from
// NULL in a unique index, so ON CONFLICT never fires for global aliases
// (userID == uuid.Nil, stored as user_id NULL): three identical global
// AddAlias calls produce three duplicate rows, verified empirically. This is
// left as-is (no SQL/migration change) because no production code path
// writes global aliases today — only tests do. The consequence if that ever
// changes: Resolve's global alias query (tier 1, food_aliases WHERE user_id
// IS NULL) has no DISTINCT and applies LIMIT, so duplicate global rows for
// one alias consume LIMIT slots, and genuinely distinct global aliases
// sorted after the cutoff could be silently missed.
func (r Repository) AddAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(
		`INSERT INTO food_aliases (alias, food_item_id, user_id) VALUES (?, ?, ?)
		 ON CONFLICT (user_id, lower(alias), food_item_id) DO NOTHING`,
		key, foodItemID, aliasOwner(userID)).Error; err != nil {
		return fmt.Errorf("nutrition: add alias insert: %w", err)
	}
	return nil
}

// RemoveAlias deletes the personal alias (userID, alias, foodItemID). It is
// the retraction half of a correction: undoing an edit must un-teach exactly
// what that edit taught, and nothing else. Deleting a global alias is not
// supported — a blank alias or uuid.Nil owner is a no-op — so a client can
// never erase curated data. Deleting a row that is not there is not an error.
func (r Repository) RemoveAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" || userID == uuid.Nil {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(
		"DELETE FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, key, foodItemID).Error; err != nil {
		return fmt.Errorf("nutrition: remove alias: %w", err)
	}
	return nil
}
