package admin

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// FoodInput is what an admin caller may set on a food row. It is a distinct
// type from nutrition.FoodItem so a caller can never pass through a field it
// has no business setting directly — id, created_at, updated_at, deleted_at,
// normalized_name (derived from Name) and embedding (derived, or cleared, by
// the mutation itself — see UpdateFood).
type FoodInput struct {
	Name           string
	Brand          string
	Provenance     string
	Barcode        *string
	ServingDesc    string
	ServingGrams   float64
	KcalPer100g    float64
	ProteinPer100g float64
	CarbsPer100g   float64
	FatPer100g     float64
	FiberPer100g   float64
}

// foodSnapshot is the shape before/after audit snapshots are built from. It
// deliberately duplicates part of nutrition.FoodItem rather than reusing it:
// FoodItem carries no DeletedAt, UpdatedAt or Embedding field (deliberately —
// see nutrition/repository.go and migration 000023), so marshalling a
// FoodItem straight into kora_admin_events would silently omit the exact
// columns a soft delete or a rename mutates. HasEmbedding is a presence bit,
// not the vector itself: the vector is large, write-only from an audit
// trail's perspective, and never needs to be diffed by a human reviewing
// kora_admin_events.
type foodSnapshot struct {
	ID             uuid.UUID  `gorm:"column:id" json:"id"`
	Name           string     `gorm:"column:name" json:"name"`
	Brand          string     `gorm:"column:brand" json:"brand"`
	NormalizedName string     `gorm:"column:normalized_name" json:"normalized_name"`
	Provenance     string     `gorm:"column:provenance" json:"provenance"`
	Barcode        *string    `gorm:"column:barcode" json:"barcode,omitempty"`
	ServingDesc    string     `gorm:"column:serving_desc" json:"serving_desc"`
	ServingGrams   float64    `gorm:"column:serving_grams" json:"serving_grams"`
	KcalPer100g    float64    `gorm:"column:kcal_per_100g" json:"kcal_per_100g"`
	ProteinPer100g float64    `gorm:"column:protein_per_100g" json:"protein_per_100g"`
	CarbsPer100g   float64    `gorm:"column:carbs_per_100g" json:"carbs_per_100g"`
	FatPer100g     float64    `gorm:"column:fat_per_100g" json:"fat_per_100g"`
	FiberPer100g   float64    `gorm:"column:fiber_per_100g" json:"fiber_per_100g"`
	HasEmbedding   bool       `gorm:"column:has_embedding" json:"has_embedding"`
	CreatedAt      time.Time  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt      time.Time  `gorm:"column:updated_at" json:"updated_at"`
	DeletedAt      *time.Time `gorm:"column:deleted_at" json:"deleted_at,omitempty"`
}

const snapshotSelect = `id, name, brand, normalized_name, provenance, barcode,
	serving_desc, serving_grams, kcal_per_100g, protein_per_100g, carbs_per_100g,
	fat_per_100g, fiber_per_100g, (embedding IS NOT NULL) AS has_embedding,
	created_at, updated_at, deleted_at`

// snapshotQuery loads one food_items row into a foodSnapshot. liveOnly=true
// additionally requires deleted_at IS NULL, for callers that must not act on
// (or capture a "before" of) an already-retired row. A row that does not
// match returns gorm.ErrRecordNotFound, the same sentinel First/Take use,
// even though this goes through Scan (which — unlike First — does not set
// that error on a zero-row result on its own).
func snapshotQuery(tx *gorm.DB, id uuid.UUID, liveOnly bool) (foodSnapshot, error) {
	q := tx.Table("food_items").Select(snapshotSelect).Where("id = ?", id)
	if liveOnly {
		q = q.Where("deleted_at IS NULL")
	}
	var s foodSnapshot
	if err := q.Scan(&s).Error; err != nil {
		return foodSnapshot{}, err
	}
	if s.ID == uuid.Nil {
		return foodSnapshot{}, gorm.ErrRecordNotFound
	}
	return s, nil
}

// loadFoodSnapshot loads a food_items row regardless of retirement status —
// for capturing an "after" snapshot once a mutation (including a soft
// delete) has already been applied.
func loadFoodSnapshot(tx *gorm.DB, id uuid.UUID) (foodSnapshot, error) {
	return snapshotQuery(tx, id, false)
}

// loadLiveFoodSnapshot loads a food_items row only if it is not (yet)
// retired — for capturing a "before" snapshot, and for refusing to mutate a
// food that is already soft-deleted.
func loadLiveFoodSnapshot(tx *gorm.DB, id uuid.UUID) (foodSnapshot, error) {
	return snapshotQuery(tx, id, true)
}

// MutationRepository is the write surface for the admin food index: create,
// update and soft-delete, each wrapping its DB write and its
// kora_admin_events row in one transaction (see events.go's recordEvent),
// and each taking the actor identity as a parameter rather than reading it
// from anything client-supplied.
type MutationRepository struct {
	db *gorm.DB
	// cache is the resolve cache's invalidation-epoch surface (see
	// ai.Generation). It is bumped AFTER the DB transaction below commits,
	// never inside it: Redis is a separate resource from Postgres, so there
	// is no way to make the bump part of the same atomic unit as the row
	// write, and bumping speculatively before a commit that might still roll
	// back would invalidate the cache for a mutation that never happened.
	cache ai.Generation
}

func NewMutationRepository(db *gorm.DB, cache ai.Generation) MutationRepository {
	return MutationRepository{db: db, cache: cache}
}

// CreateFood inserts a new food row and its audit event in one transaction.
func (r MutationRepository) CreateFood(ctx context.Context, actor Actor, in FoodInput) (nutrition.FoodItem, error) {
	var created nutrition.FoodItem
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		item := nutrition.FoodItem{
			Name:           in.Name,
			Brand:          in.Brand,
			NormalizedName: nutrition.Normalize(in.Name),
			Provenance:     in.Provenance,
			Barcode:        in.Barcode,
			ServingDesc:    in.ServingDesc,
			ServingGrams:   in.ServingGrams,
			KcalPer100g:    in.KcalPer100g,
			ProteinPer100g: in.ProteinPer100g,
			CarbsPer100g:   in.CarbsPer100g,
			FatPer100g:     in.FatPer100g,
			FiberPer100g:   in.FiberPer100g,
		}
		// updated_at is left to its column DEFAULT now() (migration 000023):
		// unlike UpdateFood/SoftDeleteFood below, this is a genuine INSERT,
		// not a map-form Updates call, so the "GORM map-form Updates bypasses
		// hooks" hazard does not apply here — Postgres itself supplies the
		// value for a column this INSERT never mentions.
		if err := tx.Create(&item).Error; err != nil {
			return fmt.Errorf("admin: create food: %w", err)
		}

		after, err := loadFoodSnapshot(tx, item.ID)
		if err != nil {
			return fmt.Errorf("admin: create food: snapshot: %w", err)
		}
		if err := recordEvent(tx, actor, ActionFoodCreated, TargetTypeFood, item.ID, nil, after); err != nil {
			return err
		}

		created = item
		return nil
	})
	if err != nil {
		return nutrition.FoodItem{}, err
	}
	return created, nil
}

// UpdateFood applies an edit, records the audit event, and — in the same
// transaction — clears the embedding if the edit renamed the food. After the
// transaction commits, it bumps the resolve cache's invalidation generation
// if the edit changed any macro, so every cached resolution that could have
// embedded this food's old numbers becomes unreachable (see ai.Generation's
// doc comment).
func (r MutationRepository) UpdateFood(ctx context.Context, actor Actor, id uuid.UUID, in FoodInput) (nutrition.FoodItem, error) {
	var (
		updated       nutrition.FoodItem
		macrosChanged bool
	)
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		before, err := loadLiveFoodSnapshot(tx, id)
		if err != nil {
			return fmt.Errorf("admin: update food: load: %w", err)
		}

		normalized := nutrition.Normalize(in.Name)
		// Compared as two FRESHLY computed normalizations, not against
		// before.NormalizedName as stored: a stored normalized_name can be
		// stale (that's the entire reason BackfillNormalizedNames exists),
		// so trusting it here could either miss a real rename or flag one
		// that never happened, depending on which direction the drift went.
		renamed := normalized != nutrition.Normalize(before.Name)
		macrosChanged = in.KcalPer100g != before.KcalPer100g ||
			in.ProteinPer100g != before.ProteinPer100g ||
			in.CarbsPer100g != before.CarbsPer100g ||
			in.FatPer100g != before.FatPer100g ||
			in.FiberPer100g != before.FiberPer100g

		now := time.Now().UTC()
		values := map[string]any{
			"name":             in.Name,
			"brand":            in.Brand,
			"normalized_name":  normalized,
			"provenance":       in.Provenance,
			"barcode":          in.Barcode,
			"serving_desc":     in.ServingDesc,
			"serving_grams":    in.ServingGrams,
			"kcal_per_100g":    in.KcalPer100g,
			"protein_per_100g": in.ProteinPer100g,
			"carbs_per_100g":   in.CarbsPer100g,
			"fat_per_100g":     in.FatPer100g,
			"fiber_per_100g":   in.FiberPer100g,
			// There are no triggers in this schema (migration 000023); GORM's
			// map-form Updates bypasses autoUpdateTime hooks entirely even if
			// FoodItem had one, so updated_at MUST be set explicitly here or
			// it silently goes stale. See the package doc comment on the
			// updated_at mechanism choice.
			"updated_at": now,
		}
		if renamed {
			// A stale embedding is worse than a missing one: kora_food_index_embedded
			// still counts this row as done, so nothing ever re-queues it (task-4
			// brief, invariant 2). Clearing it in the SAME statement as the rename
			// means there is no row state where the name has changed but the
			// embedding hasn't caught up.
			values["embedding"] = nil
		}

		res := tx.Model(&nutrition.FoodItem{}).
			Where("id = ? AND deleted_at IS NULL", id).
			Updates(values)
		if res.Error != nil {
			return fmt.Errorf("admin: update food: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return fmt.Errorf("admin: update food: %w", gorm.ErrRecordNotFound)
		}

		after, err := loadFoodSnapshot(tx, id)
		if err != nil {
			return fmt.Errorf("admin: update food: reload: %w", err)
		}
		if err := recordEvent(tx, actor, ActionFoodUpdated, TargetTypeFood, id, before, after); err != nil {
			return err
		}

		var item nutrition.FoodItem
		if err := tx.Where("id = ?", id).First(&item).Error; err != nil {
			return fmt.Errorf("admin: update food: reload item: %w", err)
		}
		updated = item
		return nil
	})
	if err != nil {
		return nutrition.FoodItem{}, err
	}

	if macrosChanged {
		if err := r.cache.BumpGeneration(ctx); err != nil {
			// The DB write already committed; a failed bump means stale
			// cache entries can survive, so this is surfaced as an error
			// rather than swallowed, even though the food row itself did
			// update successfully (updated is still returned, not zeroed).
			return updated, fmt.Errorf("admin: update food: bump cache generation: %w", err)
		}
	}
	return updated, nil
}

// SoftDeleteFood retires a food by setting deleted_at — it NEVER issues a
// DELETE. food_aliases, pins and saved_meal_items all CASCADE off
// food_items.id (see migration 000023's comment), so a real DELETE here
// would silently destroy a user's taught corrections, pins and saved meals
// along with the food row; deleted_at exists specifically so those three
// survive.
func (r MutationRepository) SoftDeleteFood(ctx context.Context, actor Actor, id uuid.UUID) (nutrition.FoodItem, error) {
	var deleted nutrition.FoodItem
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		before, err := loadLiveFoodSnapshot(tx, id)
		if err != nil {
			return fmt.Errorf("admin: soft delete food: load: %w", err)
		}

		now := time.Now().UTC()
		res := tx.Model(&nutrition.FoodItem{}).
			Where("id = ? AND deleted_at IS NULL", id).
			Updates(map[string]any{"deleted_at": now, "updated_at": now})
		if res.Error != nil {
			return fmt.Errorf("admin: soft delete food: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return fmt.Errorf("admin: soft delete food: %w", gorm.ErrRecordNotFound)
		}

		// Unfiltered: the row is now retired, so a live-only load would find
		// nothing and this "after" snapshot needs to show deleted_at set.
		after, err := loadFoodSnapshot(tx, id)
		if err != nil {
			return fmt.Errorf("admin: soft delete food: reload: %w", err)
		}
		if err := recordEvent(tx, actor, ActionFoodDeleted, TargetTypeFood, id, before, after); err != nil {
			return err
		}

		var item nutrition.FoodItem
		if err := tx.Where("id = ?", id).First(&item).Error; err != nil {
			return fmt.Errorf("admin: soft delete food: reload item: %w", err)
		}
		deleted = item
		return nil
	})
	if err != nil {
		return nutrition.FoodItem{}, err
	}
	return deleted, nil
}
