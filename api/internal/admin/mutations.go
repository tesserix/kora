package admin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// pgUniqueViolation is the Postgres SQLSTATE for a unique-constraint
// violation (23505). gorm.Config here has no TranslateError (see
// foodlog/repository.go:74-77, which documents exactly this and chose
// ON CONFLICT DO NOTHING instead), so gorm.ErrDuplicatedKey is never
// returned — the only way to recognise this failure is to unwrap the raw
// driver error. That is what makes github.com/jackc/pgx/v5/pgconn a direct
// dependency of this package: CreateFood's barcode backstop below is the
// one place in this service that needs it (task-5 brief, Rider 2).
const pgUniqueViolation = "23505"

// Sentinels the handler layer distinguishes with errors.Is. Each exists
// because the DB-level failure it wraps is otherwise indistinguishable from
// a different HTTP outcome: ErrStaleUpdate from a plain "not found"
// (404 vs 409), ErrDuplicateBarcode from an opaque constraint-violation 500,
// and ErrCacheGenerationBump from "the mutation itself failed" when in fact
// the DB transaction already committed.
var (
	// ErrStaleUpdate reports that a PATCH's updated_at precondition did not
	// match the stored row at UPDATE time. loadLiveFoodSnapshotForUpdate
	// already proved the row exists, is live, and is locked by this
	// transaction before this sentinel can ever fire — so it is never the
	// "missing or retired" case (that is gorm.ErrRecordNotFound, from the
	// earlier load), only a genuine stale/mismatched updated_at.
	ErrStaleUpdate = errors.New("admin: stale update")

	// ErrDuplicateBarcode reports that a create collided with an existing —
	// or already soft-deleted — row on idx_food_items_barcode. Produced
	// either by CreateFood's in-transaction pre-check or, as a backstop for
	// the concurrent-insert race the pre-check cannot close, by unwrapping
	// a 23505 off the INSERT itself.
	ErrDuplicateBarcode = errors.New("admin: duplicate barcode")

	// ErrCacheGenerationBump reports that the DB transaction committed
	// successfully but the POST-COMMIT resolve-cache generation bump
	// failed. UpdateFood and SoftDeleteFood both wrap it with %w alongside
	// the underlying cache error, so the handler can render the mutation as
	// the success it was (errors.Is against this sentinel) while still
	// logging the real cause server-side.
	ErrCacheGenerationBump = errors.New("admin: cache generation bump failed")
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

// FoodSnapshot is the shape before/after audit snapshots are built from, AND
// (task-5 brief, Rider 3) the exported response shape CreateFood, UpdateFood
// and SoftDeleteFood all now return. It deliberately duplicates part of
// nutrition.FoodItem rather than reusing it: FoodItem carries no DeletedAt,
// UpdatedAt or Embedding field (deliberately — see nutrition/repository.go
// and migration 000023), so marshalling a FoodItem straight into
// kora_admin_events — or back to an admin caller — would silently omit the
// exact columns a soft delete or a rename mutates, and a DELETE response
// built from FoodItem could never show the caller that the food is now
// retired. Exporting this existing type (rather than hand-rolling a second,
// near-identical response struct) is the smaller change: its JSON tags
// already say exactly what a caller needs, and one type can't drift from the
// other's shape over time. HasEmbedding is a presence bit, not the vector
// itself: the vector is large, write-only from an audit trail's or an
// admin's perspective, and never needs to be diffed by a human reviewing
// kora_admin_events or an operator reading a mutation's response.
type FoodSnapshot struct {
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

// snapshotQuery loads one food_items row into a FoodSnapshot. liveOnly=true
// additionally requires deleted_at IS NULL, for callers that must not act on
// (or capture a "before" of) an already-retired row. A row that does not
// match returns gorm.ErrRecordNotFound, the same sentinel First/Take use,
// even though this goes through Scan (which — unlike First — does not set
// that error on a zero-row result on its own).
func snapshotQuery(tx *gorm.DB, id uuid.UUID, liveOnly bool) (FoodSnapshot, error) {
	q := tx.Table("food_items").Select(snapshotSelect).Where("id = ?", id)
	if liveOnly {
		q = q.Where("deleted_at IS NULL")
	}
	var s FoodSnapshot
	if err := q.Scan(&s).Error; err != nil {
		return FoodSnapshot{}, err
	}
	if s.ID == uuid.Nil {
		return FoodSnapshot{}, gorm.ErrRecordNotFound
	}
	return s, nil
}

// loadFoodSnapshot loads a food_items row regardless of retirement status —
// for capturing an "after" snapshot once a mutation (including a soft
// delete) has already been applied.
func loadFoodSnapshot(tx *gorm.DB, id uuid.UUID) (FoodSnapshot, error) {
	return snapshotQuery(tx, id, false)
}

// loadLiveFoodSnapshotForUpdate loads a food_items row only if it is not
// (yet) retired, taking a `FOR UPDATE` row lock in the same statement — for
// capturing a "before" snapshot ahead of a write, and for refusing to mutate
// a food that is already soft-deleted. The lock, not just the liveOnly
// filter, is what makes two concurrent admin edits on the same row
// serialise instead of race: without it, two SELECTs can both read the same
// pre-edit "before" while neither write has landed yet, the second UPDATE
// then overwrites the first (the map-form Updates below writes every
// column), and the audit chain breaks — the second event's `before` shows
// the row as it was before EITHER edit, never becoming the first edit's
// `after`. It also closes the specific hole where a macro change goes
// unnoticed: if admin B's "before" is stale, a real edit (e.g. kcal
// 100->200 by A, then 200->100 by B reading the stale 100) is judged a
// no-op and the resolve cache is never invalidated even though the stored
// value changed twice. applyLiveOnlyUpdate below is the second, independent
// half of the same protection, for a caller that only has this lock
// weakened or removed.
func loadLiveFoodSnapshotForUpdate(tx *gorm.DB, id uuid.UUID) (FoodSnapshot, error) {
	return snapshotQuery(tx.Clauses(clause.Locking{Strength: "UPDATE"}), id, true)
}

// applyLiveOnlyUpdate applies values to the food_items row identified by id,
// but ONLY if it is still live (deleted_at IS NULL) at the moment this
// UPDATE itself executes — not merely at the moment of an earlier read. This
// is what stops an edit from landing on a food that was retired after this
// mutation's before-load, and stops a second soft delete from overwriting
// the first one's deleted_at, independently of the row lock taken by
// loadLiveFoodSnapshotForUpdate. Shared by UpdateFood and SoftDeleteFood so
// there is exactly one place this guard could be dropped from, not two.
//
// expectedUpdatedAt, when non-nil, adds "AND updated_at = ?" to the WHERE
// clause — the optimistic-concurrency precondition for UpdateFood's PATCH
// (task-5 brief, Rider 1). SoftDeleteFood has no such precondition (a DELETE
// is not a "my view of the row" edit the way a PATCH is) and passes nil.
func applyLiveOnlyUpdate(tx *gorm.DB, id uuid.UUID, values map[string]any, expectedUpdatedAt *time.Time) (rowsAffected int64, err error) {
	q := tx.Model(&nutrition.FoodItem{}).Where("id = ? AND deleted_at IS NULL", id)
	if expectedUpdatedAt != nil {
		q = q.Where("updated_at = ?", *expectedUpdatedAt)
	}
	res := q.Updates(values)
	return res.RowsAffected, res.Error
}

// barcodeEqual compares two nullable barcodes for the "did anything actually
// change" check in UpdateFood: two nils are equal, a nil and a non-nil are
// never equal, and two non-nils are equal iff their values match.
func barcodeEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
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
//
// Barcode collisions are guarded twice (task-5 brief, Rider 2). First, an
// in-transaction pre-check below queries food_items for an existing row with
// the same barcode BEFORE the INSERT — deliberately UNFILTERED on
// deleted_at, because idx_food_items_barcode (migration 000002) is itself
// not filtered on deleted_at, so an already-retired row still owns the
// barcode as far as Postgres is concerned. Second, since that pre-check and
// the INSERT are not atomic with each other, a concurrent create racing
// between them can still slip through and hit the unique index — that race
// is closed by unwrapping a raw *pgconn.PgError off the INSERT itself and
// checking for SQLSTATE 23505 (pgUniqueViolation), the backstop no
// application-level pre-check can fully replace.
func (r MutationRepository) CreateFood(ctx context.Context, actor Actor, in FoodInput) (FoodSnapshot, error) {
	var created FoodSnapshot
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if in.Barcode != nil {
			if err := checkBarcodeCollision(tx, *in.Barcode); err != nil {
				return err
			}
		}

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
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
				return fmt.Errorf("admin: create food: barcode collision: %w", ErrDuplicateBarcode)
			}
			return fmt.Errorf("admin: create food: %w", err)
		}

		after, err := loadFoodSnapshot(tx, item.ID)
		if err != nil {
			return fmt.Errorf("admin: create food: snapshot: %w", err)
		}
		if err := recordEvent(tx, actor, ActionFoodCreated, TargetTypeFood, item.ID, nil, after); err != nil {
			return err
		}

		created = after
		return nil
	})
	if err != nil {
		return FoodSnapshot{}, err
	}
	return created, nil
}

// checkBarcodeCollision is CreateFood's in-transaction pre-check: it looks
// for any food_items row — live or already soft-deleted — that already owns
// barcode, and if one exists, names it in the returned error so an operator
// does not have to go hunting for what they collided with.
func checkBarcodeCollision(tx *gorm.DB, barcode string) error {
	var existing struct {
		ID        uuid.UUID
		Name      string
		DeletedAt *time.Time
	}
	err := tx.Table("food_items").
		Select("id, name, deleted_at").
		Where("barcode = ?", barcode).
		Limit(1).
		Scan(&existing).Error
	if err != nil {
		return fmt.Errorf("admin: create food: barcode pre-check: %w", err)
	}
	if existing.ID == uuid.Nil {
		return nil
	}
	status := "an existing"
	if existing.DeletedAt != nil {
		status = "an already-retired"
	}
	return fmt.Errorf("admin: create food: barcode %q already belongs to %s food %q (%s): %w",
		barcode, status, existing.Name, existing.ID, ErrDuplicateBarcode)
}

// UpdateFood applies an edit, records the audit event, and — in the same
// transaction — clears the embedding if the edit renamed the food. After the
// transaction commits, it bumps the resolve cache's invalidation generation
// if the edit ACTUALLY CHANGED anything on the row — any field, not only a
// macro — so every cached resolution that could have embedded this food's
// old name or numbers becomes unreachable (see ai.Generation's doc comment).
// This is deliberately broad: a cached ai.Resolution embeds the whole
// nutrition.FoodItem, so a rename left uninvalidated keeps serving the old
// name from cache for up to the resolve cache's 24h TTL, exactly like a
// macro change would. A genuine no-op edit (every field identical to what's
// already stored) still does not bump — see
// TestUpdateFoodBumpsCacheGenerationOnAnyChangeButNotOnNoOp.
// expectedUpdatedAt is the optimistic-concurrency precondition (task-5
// brief, Rider 1): the caller must supply the updated_at it last read for
// this row, and the UPDATE only takes effect if that still matches the
// stored value at write time. loadLiveFoodSnapshotForUpdate above already
// proves the row exists, is live, and is locked by this transaction before
// applyLiveOnlyUpdate ever runs — so a 0-rows result from THAT call can only
// mean the updated_at precondition failed (ErrStaleUpdate below), never
// "missing or retired" (that case already returned gorm.ErrRecordNotFound
// from the load, above).
func (r MutationRepository) UpdateFood(ctx context.Context, actor Actor, id uuid.UUID, in FoodInput, expectedUpdatedAt time.Time) (FoodSnapshot, error) {
	var (
		updated FoodSnapshot
		changed bool
	)
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		before, err := loadLiveFoodSnapshotForUpdate(tx, id)
		if err != nil {
			return fmt.Errorf("admin: update food: load: %w", err)
		}

		normalized := nutrition.Normalize(in.Name)
		// Compared against the RAW stored name, not a normalized form on
		// either side: cmd/embed embeds row.Name verbatim, not
		// normalized_name, so a punctuation-only rename that normalizes
		// identically ("Coca-Cola X" -> "Coca Cola X") still changes what
		// gets embedded and must still clear the stale vector. Comparing
		// normalized forms (on either side) would miss exactly that case.
		nameChanged := in.Name != before.Name
		macrosChanged := in.KcalPer100g != before.KcalPer100g ||
			in.ProteinPer100g != before.ProteinPer100g ||
			in.CarbsPer100g != before.CarbsPer100g ||
			in.FatPer100g != before.FatPer100g ||
			in.FiberPer100g != before.FiberPer100g
		otherFieldsChanged := in.Brand != before.Brand ||
			in.Provenance != before.Provenance ||
			!barcodeEqual(in.Barcode, before.Barcode) ||
			in.ServingDesc != before.ServingDesc ||
			in.ServingGrams != before.ServingGrams
		changed = nameChanged || macrosChanged || otherFieldsChanged

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
			// There are no triggers in this schema (migration 000023), and
			// GORM's map-form Updates bypasses autoUpdateTime hooks entirely
			// even if FoodItem had one, so updated_at MUST be set explicitly
			// here or it silently goes stale on every edit — see migration
			// 000023's backfill comment for why that would be an
			// unrecoverable lie once shipped (a "last edited" column reading
			// "never edited" forever).
			"updated_at": now,
		}
		if nameChanged {
			// A stale embedding is worse than a missing one: kora_food_index_embedded
			// still counts this row as done, so nothing ever re-queues it (task-4
			// brief, invariant 2). Clearing it in the SAME statement as the rename
			// means there is no row state where the name has changed but the
			// embedding hasn't caught up.
			values["embedding"] = nil
		}

		rows, err := applyLiveOnlyUpdate(tx, id, values, &expectedUpdatedAt)
		if err != nil {
			return fmt.Errorf("admin: update food: %w", err)
		}
		if rows == 0 {
			// The load above already proved the row is live and locked it,
			// so the only way this UPDATE can still affect 0 rows is that
			// updated_at no longer matches expectedUpdatedAt — i.e. someone
			// else wrote this row between this caller's read and this write.
			return fmt.Errorf("admin: update food: %w", ErrStaleUpdate)
		}

		after, err := loadFoodSnapshot(tx, id)
		if err != nil {
			return fmt.Errorf("admin: update food: reload: %w", err)
		}
		if err := recordEvent(tx, actor, ActionFoodUpdated, TargetTypeFood, id, before, after); err != nil {
			return err
		}

		updated = after
		return nil
	})
	if err != nil {
		return FoodSnapshot{}, err
	}

	if changed {
		if err := r.cache.BumpGeneration(ctx); err != nil {
			// The DB write already committed; the mutation itself succeeded
			// (updated is still returned, not zeroed) — ErrCacheGenerationBump
			// lets the handler tell "commit failed" apart from "commit
			// succeeded, but the post-commit cache bump did not" and render
			// the latter as the success it is (task-5 brief, Rider 4).
			return updated, fmt.Errorf("admin: update food: bump cache generation: %w: %w", ErrCacheGenerationBump, err)
		}
	}
	return updated, nil
}

// SoftDeleteFood retires a food by setting deleted_at — it NEVER issues a
// DELETE. food_aliases, pins and saved_meal_items all CASCADE off
// food_items.id (see migration 000023's comment), so a real DELETE here
// would silently destroy a user's taught corrections, pins and saved meals
// along with the food row; deleted_at exists specifically so those three
// survive. After the transaction commits, it unconditionally bumps the
// resolve cache's invalidation generation: the deleted_at IS NULL guard on
// the write means a successful soft delete is always a real state change
// (there is no no-op case to skip, unlike UpdateFood), and without the bump
// an operator retiring a wrong food would keep having it served from cache
// for up to the resolve cache's 24h TTL, with no way to tell whether the
// retirement worked.
func (r MutationRepository) SoftDeleteFood(ctx context.Context, actor Actor, id uuid.UUID) (FoodSnapshot, error) {
	var deleted FoodSnapshot
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		before, err := loadLiveFoodSnapshotForUpdate(tx, id)
		if err != nil {
			return fmt.Errorf("admin: soft delete food: load: %w", err)
		}

		now := time.Now().UTC()
		// nil: SoftDeleteFood carries no updated_at precondition (see
		// applyLiveOnlyUpdate's doc comment) — the deleted_at IS NULL guard
		// on the write is this mutation's only concurrency guard, and it is
		// sufficient: there is no "my view of the row" for a delete to be
		// stale against.
		rows, err := applyLiveOnlyUpdate(tx, id, map[string]any{"deleted_at": now, "updated_at": now}, nil)
		if err != nil {
			return fmt.Errorf("admin: soft delete food: %w", err)
		}
		if rows == 0 {
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

		deleted = after
		return nil
	})
	if err != nil {
		return FoodSnapshot{}, err
	}

	if err := r.cache.BumpGeneration(ctx); err != nil {
		// Same trade-off as UpdateFood's post-commit bump: the DB write
		// already committed, so the retirement itself succeeded (deleted is
		// still returned, not zeroed) — ErrCacheGenerationBump lets the
		// handler render this as the success it is (task-5 brief, Rider 4).
		return deleted, fmt.Errorf("admin: soft delete food: bump cache generation: %w: %w", ErrCacheGenerationBump, err)
	}
	return deleted, nil
}

// FoodMutator is the write surface the handler depends on, so handler tests
// need no database — mirrors FoodLister's role for the read side
// (repository.go).
type FoodMutator interface {
	CreateFood(ctx context.Context, actor Actor, in FoodInput) (FoodSnapshot, error)
	UpdateFood(ctx context.Context, actor Actor, id uuid.UUID, in FoodInput, expectedUpdatedAt time.Time) (FoodSnapshot, error)
	SoftDeleteFood(ctx context.Context, actor Actor, id uuid.UUID) (FoodSnapshot, error)
}

// Compile-time assertion that MutationRepository satisfies FoodMutator.
// Without this, a signature drift between the two compiles clean here and
// only surfaces when router.go wires MutationRepository into NewHandler.
var _ FoodMutator = MutationRepository{}
