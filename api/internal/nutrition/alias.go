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
// The alias is stored lower+trim to match idx_food_aliases_unique ON
// food_aliases (user_id, lower(alias)) and the alias tier in Resolve — NOT
// Normalize, which would strip punctuation/singularize and cause future
// lookups to miss. A blank alias is a no-op.
//
// Invariant for PERSONAL aliases (non-NULL user_id): a given user's phrase
// maps to EXACTLY ONE food item, enforced by idx_food_aliases_unique — a real
// database constraint, not an application-level check-then-insert (which
// cannot be trusted: two concurrent corrections of the same phrase could both
// observe no conflicting row and both insert). The single statement below is
// a real upsert: ON CONFLICT (user_id, lower(alias)) DO UPDATE overwrites the
// existing row's food_item_id, so the latest correction always wins,
// atomically, with no separate delete step and no transaction required. The
// row's original created_at is preserved by the UPDATE — that's fine, since
// nothing after this migration depends on a personal alias's created_at (see
// nutrition/repository.go's personal-alias query, which can return at most
// one row and so has no ORDER BY to preserve).
//
// Global aliases (userID == uuid.Nil, stored as user_id NULL) are NOT
// deduped: Postgres treats NULL as DISTINCT from NULL in a unique index, so
// ON CONFLICT never fires for them — three identical global AddAlias calls
// produce three duplicate rows, verified empirically. This is accepted
// because no production code path writes global aliases today — only tests
// do. The consequence if that ever changes: Resolve's global alias query
// (tier 1, food_aliases WHERE user_id IS NULL) has no DISTINCT and applies
// LIMIT, so duplicate global rows for one alias consume LIMIT slots, and
// genuinely distinct global aliases sorted after the cutoff could be
// silently missed.
func (r Repository) AddAlias(ctx context.Context, userID uuid.UUID, alias string, foodItemID uuid.UUID) error {
	key := strings.ToLower(strings.TrimSpace(alias))
	if key == "" {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(
		`INSERT INTO food_aliases (alias, food_item_id, user_id) VALUES (?, ?, ?)
		 ON CONFLICT (user_id, lower(alias)) DO UPDATE SET food_item_id = EXCLUDED.food_item_id`,
		key, foodItemID, aliasOwner(userID)).Error; err != nil {
		return fmt.Errorf("nutrition: add alias upsert: %w", err)
	}
	return nil
}

// LookupPersonalAlias looks up the food item userID has personally
// corrected `phrase` to resolve to, if any. It is the raw-phrase
// counterpart to Resolve's alias tier: Resolve is keyed off whatever phrase
// its caller passes in (which, for an AI resolve, is the model's own guess
// string — not necessarily the user's original words), whereas this looks
// up the user's raw phrase directly. That is exactly the primitive
// ai.Resolver.ResolveText's alias short-circuit needs so a correction takes
// effect before the model is ever called.
//
// found=false (not an error) means no personal alias exists for this
// (userID, phrase) pair — including when phrase matches a curated/global
// alias (food_aliases.user_id IS NULL): those are not a personal
// correction and must never short-circuit resolution. uuid.Nil always
// returns not-found without querying, mirroring AddAlias/RemoveAlias's
// zero-value handling — it must never be treated as a wildcard that could
// match another user's alias.
func (r Repository) LookupPersonalAlias(ctx context.Context, userID uuid.UUID, phrase string) (FoodItem, bool, error) {
	if userID == uuid.Nil {
		return FoodItem{}, false, nil
	}
	key := strings.ToLower(strings.TrimSpace(phrase))
	if key == "" {
		return FoodItem{}, false, nil
	}
	var items []FoodItem
	if err := r.db.WithContext(ctx).
		Raw(`SELECT fi.* FROM food_items fi
		     JOIN food_aliases fa ON fa.food_item_id = fi.id
		     WHERE fa.user_id = ? AND lower(fa.alias) = ? AND fi.deleted_at IS NULL
		     LIMIT 1`, userID, key).
		Scan(&items).Error; err != nil {
		return FoodItem{}, false, fmt.Errorf("nutrition: lookup personal alias: %w", err)
	}
	if len(items) == 0 {
		return FoodItem{}, false, nil
	}
	return items[0], true, nil
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
