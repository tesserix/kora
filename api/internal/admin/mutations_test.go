package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// fakeGeneration is a hermetic, in-process ai.Generation double: it lets the
// cache-bump tests assert "bumped exactly once" / "never bumped" directly,
// without standing up Redis (or miniredis) just to prove a counting
// contract that has nothing to do with how the counter is physically
// stored.
type fakeGeneration struct {
	mu    sync.Mutex
	gen   int64
	bumps int
}

var _ ai.Generation = (*fakeGeneration)(nil)

func (g *fakeGeneration) CurrentGeneration(context.Context) (int64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.gen, nil
}

func (g *fakeGeneration) BumpGeneration(context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.bumps++
	g.gen++
	return nil
}

func (g *fakeGeneration) Bumps() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.bumps
}

// seedUser inserts a minimal users row on tx, for FK'd fixtures (pins,
// saved_meals) that require a real user_id.
func seedUser(t *testing.T, tx *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, tx.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "admin-mut-"+id.String(), "admin-mut@test.dev").Error)
	return id
}

func inputFrom(item nutrition.FoodItem) FoodInput {
	return FoodInput{
		Name:           item.Name,
		Brand:          item.Brand,
		Provenance:     item.Provenance,
		Barcode:        item.Barcode,
		ServingDesc:    item.ServingDesc,
		ServingGrams:   item.ServingGrams,
		KcalPer100g:    item.KcalPer100g,
		ProteinPer100g: item.ProteinPer100g,
		CarbsPer100g:   item.CarbsPer100g,
		FatPer100g:     item.FatPer100g,
		FiberPer100g:   item.FiberPer100g,
	}
}

func hasEmbedding(t *testing.T, tx *gorm.DB, id uuid.UUID) bool {
	t.Helper()
	var got bool
	require.NoError(t, tx.Raw("SELECT embedding IS NOT NULL FROM food_items WHERE id = ?", id).Scan(&got).Error)
	return got
}

// seedFoodTx creates a food row directly (NOT via seedTx's variadic form,
// whose items slice is a copy the caller can't read IDs back from — see
// repository_test.go's re-query-by-name pattern) so the caller gets a
// populated ID.
func seedFoodTx(t *testing.T, tx *gorm.DB, name, brand string) nutrition.FoodItem {
	t.Helper()
	item := food(name, brand)
	require.NoError(t, tx.Create(&item).Error)
	return item
}

// seedFoodCommitted inserts a food row as a genuinely COMMITTED write, not
// inside a transaction later rolled back — used only by the row-lock
// concurrency test below, which needs the row visible to TWO independently
// opened transactions. seedTx's rolled-back transaction would be invisible
// to a second connection under READ COMMITTED, so it cannot be used there.
// Cleans up after itself with a direct hard delete (there is no FK from
// kora_admin_events.target_id to food_items, so the audit rows a test
// writes against this id must be cleaned up separately too).
func seedFoodCommitted(t *testing.T, db *gorm.DB, name, brand string) nutrition.FoodItem {
	t.Helper()
	item := food(name, brand)
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM kora_admin_events WHERE target_id = ?", item.ID)
		db.Exec("DELETE FROM food_items WHERE id = ?", item.ID)
	})
	return item
}

// loadUpdatedAt reads food_items.updated_at directly, bypassing
// nutrition.FoodItem (which deliberately has no UpdatedAt field — see
// foodSnapshot's doc comment).
func loadUpdatedAt(t *testing.T, tx *gorm.DB, id uuid.UUID) time.Time {
	t.Helper()
	var ts time.Time
	require.NoError(t, tx.Raw("SELECT updated_at FROM food_items WHERE id = ?", id).Scan(&ts).Error)
	return ts
}

// loadDeletedAt reads food_items.deleted_at directly; nil means still live.
func loadDeletedAt(t *testing.T, tx *gorm.DB, id uuid.UUID) *time.Time {
	t.Helper()
	var ts sql.NullTime
	require.NoError(t, tx.Raw("SELECT deleted_at FROM food_items WHERE id = ?", id).Scan(&ts).Error)
	if !ts.Valid {
		return nil
	}
	return &ts.Time
}

// TestCreateFoodWritesRowAndAuditEvent is a basic sanity check, NOT the
// atomicity proof — see its doc comment on
// TestCreateFoodAuditFailureRollsBackMutation for why "both rows exist after
// a success" cannot demonstrate atomicity on its own.
func TestCreateFoodWritesRowAndAuditEvent(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	got, err := repo.CreateFood(context.Background(), actor, FoodInput{
		Name: "zzz-admin-create", Provenance: nutrition.ProvenanceCurated,
		ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 120,
		ProteinPer100g: 5, CarbsPer100g: 10, FatPer100g: 3, FiberPer100g: 1,
	})
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, got.ID)
	assert.Equal(t, "zzz-admin-create", got.Name)

	var foodCount int64
	require.NoError(t, tx.Model(&nutrition.FoodItem{}).Where("id = ?", got.ID).Count(&foodCount).Error)
	assert.Equal(t, int64(1), foodCount)

	var event AdminEvent
	require.NoError(t, tx.Where("target_id = ? AND action = ?", got.ID, ActionFoodCreated).First(&event).Error)
	assert.Equal(t, actor.ID, event.ActorID)
	assert.Nil(t, event.Before, "a creation has no prior state")
	assert.NotNil(t, event.After)
}

// TestCreateFoodAuditFailureRollsBackMutation is the atomicity proof
// (invariant 1). A blank/whitespace actor email fails
// kora_admin_events_actor_email_check (see events_test.go's
// TestRecordEventRejectsBlankActorEmail) INSIDE the same transaction as the
// food INSERT. If the two writes were two independent commits, the food row
// would still exist here despite CreateFood returning an error — a test
// that only checked "both rows exist after a success" could never catch
// that. This test proves the negative instead: after a forced audit
// failure, the food row must be ABSENT too.
func TestCreateFoodAuditFailureRollsBackMutation(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	repo := NewMutationRepository(tx, ai.NoCache{})

	name := "zzz-admin-atomicity-" + uuid.NewString()
	badActor := Actor{ID: "admin-1", Email: "   "} // whitespace-only -> CHECK fails

	_, err := repo.CreateFood(context.Background(), badActor, FoodInput{
		Name: name, Provenance: nutrition.ProvenanceCurated,
		ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 100,
	})
	require.Error(t, err, "the audit insert must fail for a blank actor email")

	var foodCount int64
	require.NoError(t, tx.Model(&nutrition.FoodItem{}).Where("name = ?", name).Count(&foodCount).Error)
	assert.Equal(t, int64(0), foodCount,
		"a rolled-back mutation must leave NO food row behind — two independent commits would leave one")

	var eventCount int64
	require.NoError(t, tx.Model(&AdminEvent{}).Where("action = ? AND after->>'name' = ?", ActionFoodCreated, name).Count(&eventCount).Error)
	assert.Equal(t, int64(0), eventCount, "the failed audit insert itself must not have persisted either")
}

// TestUpdateFoodAuditFailureRollsBackMutation is invariant 1's atomicity
// proof for UpdateFood — the same shape as
// TestCreateFoodAuditFailureRollsBackMutation. A blank/whitespace actor
// email fails the audit INSERT's CHECK constraint inside the SAME
// transaction as the food UPDATE. If the two writes were two independent
// commits — e.g. the audit insert moved into its own savepoint with the
// error swallowed — the food row would show the EDITED values here despite
// UpdateFood returning an error. This test proves the negative: after a
// forced audit failure, the food row must still hold its PRE-EDIT values.
func TestUpdateFoodAuditFailureRollsBackMutation(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-admin-upd-atomicity-"+uuid.NewString(), "")

	repo := NewMutationRepository(tx, ai.NoCache{})
	badActor := Actor{ID: "admin-1", Email: "   "} // whitespace-only -> CHECK fails

	in := inputFrom(original)
	in.Name = "zzz-admin-upd-atomicity-renamed-" + uuid.NewString()
	in.KcalPer100g = original.KcalPer100g + 500

	_, err := repo.UpdateFood(context.Background(), badActor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.Error(t, err, "the audit insert must fail for a blank actor email")

	var got struct {
		Name        string
		KcalPer100g float64 `gorm:"column:kcal_per_100g"`
	}
	require.NoError(t, tx.Raw("SELECT name, kcal_per_100g FROM food_items WHERE id = ?", original.ID).Scan(&got).Error)
	assert.Equal(t, original.Name, got.Name,
		"a rolled-back mutation must leave the food row's PRE-EDIT name — two independent commits would show the rename")
	assert.Equal(t, original.KcalPer100g, got.KcalPer100g,
		"a rolled-back mutation must leave the food row's PRE-EDIT kcal — two independent commits would show the edit")

	var eventCount int64
	require.NoError(t, tx.Model(&AdminEvent{}).Where("target_id = ? AND action = ?", original.ID, ActionFoodUpdated).Count(&eventCount).Error)
	assert.Equal(t, int64(0), eventCount, "the failed audit insert itself must not have persisted either")
}

// TestSoftDeleteFoodAuditFailureRollsBackMutation is invariant 1's atomicity
// proof for SoftDeleteFood, the same shape again: a forced audit failure
// must leave deleted_at NULL, not just return an error.
func TestSoftDeleteFoodAuditFailureRollsBackMutation(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-admin-del-atomicity-"+uuid.NewString(), "")

	repo := NewMutationRepository(tx, ai.NoCache{})
	badActor := Actor{ID: "admin-1", Email: "   "}

	_, err := repo.SoftDeleteFood(context.Background(), badActor, target.ID)
	require.Error(t, err, "the audit insert must fail for a blank actor email")

	assert.Nil(t, loadDeletedAt(t, tx, target.ID),
		"a rolled-back soft delete must leave deleted_at NULL — two independent commits would show it retired")

	var eventCount int64
	require.NoError(t, tx.Model(&AdminEvent{}).Where("target_id = ? AND action = ?", target.ID, ActionFoodDeleted).Count(&eventCount).Error)
	assert.Equal(t, int64(0), eventCount, "the failed audit insert itself must not have persisted either")
}

// TestUpdateFoodRenameClearsEmbeddingButMacrosOnlyEditPreservesIt is
// invariant 2 and its twin, in one test so the "clears" half can't pass by
// virtue of ALWAYS nulling the embedding regardless of what changed.
func TestUpdateFoodRenameClearsEmbeddingButMacrosOnlyEditPreservesIt(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-embed-orig-"+uuid.NewString(), "")

	vec := make([]float32, 768)
	for i := range vec {
		vec[i] = 0.01
	}
	require.NoError(t, nutrition.NewRepository(tx).SetEmbedding(context.Background(), original.ID, vec))
	require.True(t, hasEmbedding(t, tx, original.ID), "fixture must start embedded or the NULL assertion below proves nothing")

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	// Macros-only edit: name (and therefore normalized_name) unchanged.
	macrosOnly := inputFrom(original)
	macrosOnly.KcalPer100g = 999
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, macrosOnly, loadUpdatedAt(t, tx, original.ID))
	require.NoError(t, err)
	assert.True(t, hasEmbedding(t, tx, original.ID), "a macros-only edit must NOT null the embedding")

	// Rename.
	renamed := inputFrom(original)
	renamed.Name = "zzz-embed-renamed-" + uuid.NewString()
	renamed.KcalPer100g = 999
	_, err = repo.UpdateFood(context.Background(), actor, original.ID, renamed, loadUpdatedAt(t, tx, original.ID))
	require.NoError(t, err)
	assert.False(t, hasEmbedding(t, tx, original.ID), "a rename must null the embedding in the same statement")
}

// TestUpdateFoodClearsEmbeddingOnPunctuationOnlyRenameThatNormalizesIdentically
// is invariant 2's minor fix (task-4 fix round 1): the embedding-clear
// decision compares in.Name against the RAW before.Name, not two freshly
// normalized forms. "Coca-Cola X" and "Coca Cola X" normalize identically
// (Normalize maps punctuation to a space), so a normalized-form comparison
// would miss this rename — but cmd/embed embeds the raw name, so the stored
// vector IS stale here and must still be cleared.
func TestUpdateFoodClearsEmbeddingOnPunctuationOnlyRenameThatNormalizesIdentically(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "Coca-Cola X "+uuid.NewString(), "")

	vec := make([]float32, 768)
	for i := range vec {
		vec[i] = 0.01
	}
	require.NoError(t, nutrition.NewRepository(tx).SetEmbedding(context.Background(), original.ID, vec))
	require.True(t, hasEmbedding(t, tx, original.ID), "fixture must start embedded or the NULL assertion below proves nothing")

	renamedName := strings.ReplaceAll(original.Name, "-", " ")
	require.NotEqual(t, original.Name, renamedName, "fixture's rename must actually change the raw name")
	require.Equal(t, nutrition.Normalize(original.Name), nutrition.Normalize(renamedName),
		"fixture's whole point: normalization must collapse the two names identically")

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	in := inputFrom(original)
	in.Name = renamedName
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.NoError(t, err)
	assert.False(t, hasEmbedding(t, tx, original.ID),
		"a raw-name-only rename must still clear the stale embedding even though normalization is unchanged")
}

// TestUpdateFoodBumpsCacheGenerationOnAnyChangeButNotOnNoOp is invariant 3
// (DELIBERATE DESIGN CHANGE, task-4 fix round 1): the cache generation must
// bump on ANY actual change to the row — not just a macros edit, see the
// rename subtest — and must NOT bump for a genuine no-op. Each subtest seeds
// its own row so an earlier subtest's write can't leak into a later
// subtest's "before" and change what counts as a no-op.
func TestUpdateFoodBumpsCacheGenerationOnAnyChangeButNotOnNoOp(t *testing.T) {
	db := testDB(t)
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	t.Run("no-op edit does not bump", func(t *testing.T) {
		tx := seedTx(t, db)
		original := seedFoodTx(t, tx, "zzz-cachebump-noop-"+uuid.NewString(), "")
		cache := &fakeGeneration{}
		repo := NewMutationRepository(tx, cache)

		_, err := repo.UpdateFood(context.Background(), actor, original.ID, inputFrom(original), loadUpdatedAt(t, tx, original.ID))
		require.NoError(t, err)
		assert.Equal(t, 0, cache.Bumps(), "an edit that changes nothing must not bump the cache generation")
	})

	t.Run("rename-only edit bumps", func(t *testing.T) {
		tx := seedTx(t, db)
		original := seedFoodTx(t, tx, "zzz-cachebump-rename-"+uuid.NewString(), "")
		cache := &fakeGeneration{}
		repo := NewMutationRepository(tx, cache)

		in := inputFrom(original)
		in.Name = "zzz-cachebump-renamed-" + uuid.NewString()
		_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
		require.NoError(t, err)
		assert.Equal(t, 1, cache.Bumps(),
			"a rename must bump the cache generation even though no macro changed — a cached ai.Resolution embeds the whole FoodItem, name included")
	})

	t.Run("macros-only edit bumps", func(t *testing.T) {
		tx := seedTx(t, db)
		original := seedFoodTx(t, tx, "zzz-cachebump-macros-"+uuid.NewString(), "")
		cache := &fakeGeneration{}
		repo := NewMutationRepository(tx, cache)

		in := inputFrom(original)
		in.ProteinPer100g = original.ProteinPer100g + 5
		_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
		require.NoError(t, err)
		assert.Equal(t, 1, cache.Bumps(), "a macros edit must bump the cache generation exactly once")
	})

	// brand-only and serving-grams-only edits pin the `otherFieldsChanged`
	// half of the `changed` expression (mutations.go's UpdateFood). Without
	// this subtest, dropping `otherFieldsChanged` from `changed` leaves every
	// other test in this file green: none of them edits brand, provenance,
	// barcode, serving_desc or serving_grams in isolation from a name or
	// macro change. An operator fixing a wrong brand or serving size would
	// then keep serving the stale cached ai.Resolution for up to 24h with no
	// way to tell the fix took.
	t.Run("brand-only edit bumps", func(t *testing.T) {
		tx := seedTx(t, db)
		original := seedFoodTx(t, tx, "zzz-cachebump-brand-"+uuid.NewString(), "original-brand")
		cache := &fakeGeneration{}
		repo := NewMutationRepository(tx, cache)

		in := inputFrom(original)
		in.Brand = "corrected-brand"
		_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
		require.NoError(t, err)
		assert.Equal(t, 1, cache.Bumps(),
			"a brand-only edit must bump the cache generation — dropping otherFieldsChanged from `changed` would miss this")
	})

	t.Run("serving-grams-only edit bumps", func(t *testing.T) {
		tx := seedTx(t, db)
		original := seedFoodTx(t, tx, "zzz-cachebump-servinggrams-"+uuid.NewString(), "")
		cache := &fakeGeneration{}
		repo := NewMutationRepository(tx, cache)

		in := inputFrom(original)
		in.ServingGrams = original.ServingGrams + 50
		_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
		require.NoError(t, err)
		assert.Equal(t, 1, cache.Bumps(),
			"a serving-grams-only edit must bump the cache generation — dropping otherFieldsChanged from `changed` would miss this")
	})
}

// TestBarcodeEqualHandlesAllNilCombinations pins barcodeEqual across all four
// nil-ness combinations (both nil, left nil, right nil, neither nil), with
// the neither-nil case split into equal and differing values. Every existing
// fixture in this package seeds a nil barcode, so without this test
// barcodeEqual's nil-handling — the exact thing that lets UpdateFood decide
// whether a barcode edit actually changed the row — is entirely uncovered:
// stubbing it to `return true` unconditionally leaves all other tests green.
func TestBarcodeEqualHandlesAllNilCombinations(t *testing.T) {
	x := "111"
	xSame := "111"
	y := "222"

	cases := []struct {
		name string
		a, b *string
		want bool
	}{
		{"both nil are equal", nil, nil, true},
		{"left nil, right non-nil are never equal", nil, &x, false},
		{"left non-nil, right nil are never equal", &x, nil, false},
		{"neither nil, equal values are equal", &x, &xSame, true},
		{"neither nil, differing values are not equal", &x, &y, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, barcodeEqual(tc.a, tc.b))
		})
	}
}

// TestCreateFoodSetsNormalizedNameFromNormalizedInput pins invariant: the
// normalized_name column must be derived via nutrition.Normalize(Name), not
// written as the raw input. That column backs the resolve full-text and
// trigram tiers (nutrition/repository.go), so a raw write here would leave a
// newly created food correctly visible in the admin table and audit trail
// while being unfindable by any user phrase that doesn't match it verbatim.
// The expectation is computed from nutrition.Normalize directly, not read
// back from the food() fixture — food()/seedFoodTx set NormalizedName to the
// raw name literally (see repository_test.go), so a fixture-derived
// expectation here would be self-fulfilling.
func TestCreateFoodSetsNormalizedNameFromNormalizedInput(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	name := "Zzz Admin Normalize Create Oats-" + uuid.NewString()
	want := nutrition.Normalize(name)
	require.NotEqual(t, name, want,
		"fixture name must genuinely differ from its normalized form or this assertion cannot discriminate raw-write from normalized-write")

	got, err := repo.CreateFood(context.Background(), actor, FoodInput{
		Name: name, Provenance: nutrition.ProvenanceCurated,
		ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 120,
	})
	require.NoError(t, err)

	var normalizedName string
	require.NoError(t, tx.Raw("SELECT normalized_name FROM food_items WHERE id = ?", got.ID).Scan(&normalizedName).Error)
	assert.Equal(t, want, normalizedName,
		"CreateFood must write nutrition.Normalize(Name) into normalized_name, not the raw input — otherwise the food is unfindable by full-text/trigram match")
	assert.NotEqual(t, name, normalizedName, "the raw name must not have been written verbatim")
}

// TestUpdateFoodSetsNormalizedNameFromNormalizedInput is
// TestCreateFoodSetsNormalizedNameFromNormalizedInput's twin for the rename
// path (mutations.go's UpdateFood): the same silent-unfindability failure
// mode applies to a rename as to a create.
func TestUpdateFoodSetsNormalizedNameFromNormalizedInput(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-admin-normalize-upd-orig-"+uuid.NewString(), "")

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	newName := "Zzz Admin Normalize Renamed Oats-" + uuid.NewString()
	want := nutrition.Normalize(newName)
	require.NotEqual(t, newName, want,
		"fixture rename must genuinely differ from its normalized form or this assertion cannot discriminate raw-write from normalized-write")

	in := inputFrom(original)
	in.Name = newName
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.NoError(t, err)

	var normalizedName string
	require.NoError(t, tx.Raw("SELECT normalized_name FROM food_items WHERE id = ?", original.ID).Scan(&normalizedName).Error)
	assert.Equal(t, want, normalizedName,
		"UpdateFood must write nutrition.Normalize(Name) into normalized_name on rename, not the raw input")
	assert.NotEqual(t, newName, normalizedName, "the raw renamed name must not have been written verbatim")
}

// TestSoftDeleteFoodAlwaysBumpsCacheGeneration is invariant 3 for
// SoftDeleteFood (task-4 fix round 1): unlike UpdateFood there is no no-op
// case here — the deleted_at IS NULL guard on the write means a successful
// soft delete is always a real state change, so the bump is unconditional.
// Without it, an operator retiring a wrong food would keep having it served
// from cache for up to the resolve cache's 24h TTL, with no way to tell
// whether the retirement worked.
func TestSoftDeleteFoodAlwaysBumpsCacheGeneration(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-cachebump-delete-"+uuid.NewString(), "")

	cache := &fakeGeneration{}
	repo := NewMutationRepository(tx, cache)
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	_, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, cache.Bumps(), "retiring a food must bump the cache generation")
}

// TestUpdateFoodAdvancesUpdatedAtForTheEditedRowOnly is invariant 2 (the
// updated_at column, task-4 fix round 1): an edit must advance updated_at
// for the row it actually touched, and must NOT touch an unrelated
// sibling's updated_at. Migration 000023 backfilled updated_at = created_at
// specifically so this column tells the truth from row one; a missing
// assertion here would let a future edit to mutations.go silently drop the
// "updated_at": now key from the map and leave every edited row reading
// "never edited" forever.
func TestUpdateFoodAdvancesUpdatedAtForTheEditedRowOnly(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	edited := seedFoodTx(t, tx, "zzz-updatedat-edit-"+uuid.NewString(), "")
	sibling := seedFoodTx(t, tx, "zzz-updatedat-sibling-"+uuid.NewString(), "")

	beforeEdited := loadUpdatedAt(t, tx, edited.ID)
	beforeSibling := loadUpdatedAt(t, tx, sibling.ID)

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	time.Sleep(5 * time.Millisecond) // ensure a wall-clock-observable gap
	in := inputFrom(edited)
	in.KcalPer100g = edited.KcalPer100g + 1
	_, err := repo.UpdateFood(context.Background(), actor, edited.ID, in, beforeEdited)
	require.NoError(t, err)

	afterEdited := loadUpdatedAt(t, tx, edited.ID)
	afterSibling := loadUpdatedAt(t, tx, sibling.ID)

	assert.True(t, afterEdited.After(beforeEdited), "updated_at must advance for the row that was actually edited")
	assert.True(t, afterSibling.Equal(beforeSibling), "an untouched sibling row's updated_at must not move")
}

// TestSoftDeleteFoodAdvancesUpdatedAt is TestUpdateFoodAdvancesUpdatedAtForTheEditedRowOnly's
// twin for SoftDeleteFood.
func TestSoftDeleteFoodAdvancesUpdatedAt(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-updatedat-delete-"+uuid.NewString(), "")

	before := loadUpdatedAt(t, tx, target.ID)

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	time.Sleep(5 * time.Millisecond)
	_, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.NoError(t, err)

	after := loadUpdatedAt(t, tx, target.ID)
	assert.True(t, after.After(before), "updated_at must advance when a food is soft-deleted")
}

// TestLoadLiveFoodSnapshotForUpdateRejectsRetiredButLoadsLiveFood is
// invariant 5's guard on the before-load (mutations.go's use of
// loadLiveFoodSnapshotForUpdate in both UpdateFood and SoftDeleteFood): an
// already-retired food must not load as a "before" snapshot, and a live one
// must still load fine. Tested directly against the loader — not through
// the full UpdateFood/SoftDeleteFood call — because the UPDATE-time guard
// (applyLiveOnlyUpdate, tested separately below) would independently reject
// an already-retired food too, so a black-box "editing a retired food
// fails" test alone cannot tell which of the two guards caught it.
func TestLoadLiveFoodSnapshotForUpdateRejectsRetiredButLoadsLiveFood(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	live := seedFoodTx(t, tx, "zzz-liveload-live-"+uuid.NewString(), "")
	retired := seedFoodTx(t, tx, "zzz-liveload-retired-"+uuid.NewString(), "")
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	_, err := loadLiveFoodSnapshotForUpdate(tx, retired.ID)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound, "an already-retired food must not be loadable as a 'before' snapshot")

	got, err := loadLiveFoodSnapshotForUpdate(tx, live.ID)
	require.NoError(t, err, "a live food must still load fine")
	assert.Equal(t, live.ID, got.ID)
}

// TestApplyLiveOnlyUpdateRejectsRetiredButUpdatesLiveFood is invariant 5's
// guard on the write itself (mutations.go's use of applyLiveOnlyUpdate in
// both UpdateFood's edit and SoftDeleteFood's retire): an already-retired
// row must not be touched — this is what stops an edit from landing on a
// retired food, and stops a second soft delete from overwriting the first
// one's deleted_at — and a live row must still be updatable. Tested
// directly against the guarded write, independent of the before-load guard
// above.
func TestApplyLiveOnlyUpdateRejectsRetiredButUpdatesLiveFood(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	live := seedFoodTx(t, tx, "zzz-applyupdate-live-"+uuid.NewString(), "")
	retired := seedFoodTx(t, tx, "zzz-applyupdate-retired-"+uuid.NewString(), "")
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", retired.ID).Error)

	rows, err := applyLiveOnlyUpdate(tx, retired.ID, map[string]any{"kcal_per_100g": 999.0}, nil)
	require.NoError(t, err)
	assert.Equal(t, int64(0), rows, "an already-retired row must not be touched by the guarded update")

	var retiredKcal float64
	require.NoError(t, tx.Raw("SELECT kcal_per_100g FROM food_items WHERE id = ?", retired.ID).Scan(&retiredKcal).Error)
	assert.NotEqual(t, 999.0, retiredKcal, "the guarded update must not have applied its values to the retired row")

	rows, err = applyLiveOnlyUpdate(tx, live.ID, map[string]any{"kcal_per_100g": 999.0}, nil)
	require.NoError(t, err)
	assert.Equal(t, int64(1), rows, "a live row must still be updatable")

	var liveKcal float64
	require.NoError(t, tx.Raw("SELECT kcal_per_100g FROM food_items WHERE id = ?", live.ID).Scan(&liveKcal).Error)
	assert.Equal(t, 999.0, liveKcal)
}

// TestUpdateFoodRejectsAlreadyRetiredFoodAndLeavesItUnchanged is the
// end-to-end (black-box) shape of invariant 5 for UpdateFood: editing an
// already-retired food must fail, and must leave it unchanged.
func TestUpdateFoodRejectsAlreadyRetiredFoodAndLeavesItUnchanged(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-editretired-"+uuid.NewString(), "")
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", target.ID).Error)

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	in := inputFrom(target)
	in.KcalPer100g = 999
	// expectedUpdatedAt is irrelevant here: loadLiveFoodSnapshotForUpdate's
	// before-load rejects an already-retired row before applyLiveOnlyUpdate
	// (and therefore this precondition) is ever reached — any value works.
	_, err := repo.UpdateFood(context.Background(), actor, target.ID, in, time.Now().UTC())
	require.Error(t, err, "editing an already-retired food must fail")
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

	var kcal float64
	require.NoError(t, tx.Raw("SELECT kcal_per_100g FROM food_items WHERE id = ?", target.ID).Scan(&kcal).Error)
	assert.NotEqual(t, 999.0, kcal, "a rejected edit must not have applied")
}

// TestSoftDeleteFoodSecondAttemptFailsAndPreservesOriginalDeletedAt is the
// end-to-end (black-box) shape of invariant 5 for SoftDeleteFood: a second
// soft delete on an already-retired food must fail, and — more importantly
// than the failure itself — must NOT overwrite deleted_at with a later
// timestamp, or the audit trail's answer to "when was this actually
// retired" would silently become wrong.
func TestSoftDeleteFoodSecondAttemptFailsAndPreservesOriginalDeletedAt(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-doubledelete-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	_, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.NoError(t, err)
	firstDeletedAt := loadDeletedAt(t, tx, target.ID)
	require.NotNil(t, firstDeletedAt, "the first soft delete must have set deleted_at")

	time.Sleep(5 * time.Millisecond)
	_, err = repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.Error(t, err, "soft-deleting an already-retired food must fail")
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)

	secondDeletedAt := loadDeletedAt(t, tx, target.ID)
	require.NotNil(t, secondDeletedAt)
	assert.True(t, secondDeletedAt.Equal(*firstDeletedAt),
		"a second soft delete attempt must not overwrite the original deleted_at")
}

// TestUpdateFoodConcurrentStaleEditIsRejectedAfterRowLockReleases is
// invariant 4's atomicity-under-contention proof, now adapted for Rider 1's
// optimistic-concurrency precondition (task-5 brief): once the row lock on
// loadLiveFoodSnapshotForUpdate forces B's before-load to wait for A's
// commit, B's PATCH carries the updated_at IT read before A ever wrote —
// genuinely stale the moment A commits — so B's own UPDATE must now affect 0
// rows and B must get ErrStaleUpdate, not silently win a last-writer-wins
// overwrite of A's edit. This is the exact hazard optimistic concurrency
// exists to close: without the row lock, B could have read the SAME pre-A
// row and still raced to a stale write; WITH the lock but WITHOUT this
// precondition, B's before-load would simply re-read A's committed values
// and let B unconditionally clobber them with B's own stale FoodInput. Only
// the two together (this test proves both) leave A's edit standing.
//
// Goroutine A bypasses the full UpdateFood call and drives
// loadLiveFoodSnapshotForUpdate/applyLiveOnlyUpdate directly so the test can
// hold the lock open on a channel for a controlled window; goroutine B goes
// through the real, public UpdateFood, exactly as a second admin's request
// would.
func TestUpdateFoodConcurrentStaleEditIsRejectedAfterRowLockReleases(t *testing.T) {
	db := testDB(t)
	original := seedFoodCommitted(t, db, "zzz-lock-"+uuid.NewString(), "")
	repo := NewMutationRepository(db, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	// B's stale precondition: the updated_at as committed by the seed,
	// before A ever writes.
	staleUpdatedAt := loadUpdatedAt(t, db, original.ID)

	aHasLock := make(chan struct{})
	aMayCommit := make(chan struct{})
	aDone := make(chan error, 1)

	go func() {
		aDone <- db.Transaction(func(tx *gorm.DB) error {
			if _, err := loadLiveFoodSnapshotForUpdate(tx, original.ID); err != nil {
				return err
			}
			close(aHasLock)
			<-aMayCommit
			_, err := applyLiveOnlyUpdate(tx, original.ID, map[string]any{
				"kcal_per_100g": 555.0,
				"updated_at":    time.Now().UTC(),
			}, nil)
			return err
		})
	}()

	<-aHasLock // A now holds the row lock and has not committed.

	bStarted := make(chan struct{})
	bUpdated := make(chan FoodSnapshot, 1)
	bErr := make(chan error, 1)
	go func() {
		close(bStarted)
		in := inputFrom(original)
		in.ProteinPer100g = original.ProteinPer100g + 9
		updated, err := repo.UpdateFood(context.Background(), actor, original.ID, in, staleUpdatedAt)
		bUpdated <- updated
		bErr <- err
	}()
	<-bStarted
	// Best-effort: give B a moment to actually reach and block on the row
	// lock before A releases it. The assertions below hold regardless of
	// exact scheduling, because they check the OUTCOME (what actually landed
	// in the row), not the interleaving itself.
	time.Sleep(50 * time.Millisecond)

	close(aMayCommit)
	require.NoError(t, <-aDone, "A's update must commit")
	err := <-bErr
	require.Error(t, err, "B's update must be rejected: its updated_at precondition is stale once A has committed")
	assert.ErrorIs(t, err, ErrStaleUpdate)
	<-bUpdated

	var kcal, protein float64
	require.NoError(t, db.Raw("SELECT kcal_per_100g, protein_per_100g FROM food_items WHERE id = ?", original.ID).
		Row().Scan(&kcal, &protein))
	assert.Equal(t, 555.0, kcal, "A's committed edit must survive B's rejected stale write")
	assert.Equal(t, original.ProteinPer100g, protein, "B's rejected edit must never have applied")

	var updateEventCount int64
	require.NoError(t, db.Model(&AdminEvent{}).
		Where("target_id = ? AND action = ?", original.ID, ActionFoodUpdated).
		Count(&updateEventCount).Error)
	assert.Equal(t, int64(0), updateEventCount,
		"neither A (bypassing UpdateFood/recordEvent entirely) nor B (rejected before recordEvent runs) should have written a food.updated audit row")
}

// TestSoftDeleteFoodPreservesCascadingRowsAndNeverIssuesHardDelete is
// invariant 4: the food row survives with deleted_at set, and an alias, a
// pin and a saved-meal item pointing at it all survive too. A hard DELETE
// would CASCADE and destroy all three (see migration 000023's comment) —
// this is the test that catches that regression.
func TestSoftDeleteFoodPreservesCascadingRowsAndNeverIssuesHardDelete(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-softdelete-"+uuid.NewString(), "")
	userID := seedUser(t, tx)

	// food_aliases: a user's taught correction.
	require.NoError(t, nutrition.NewRepository(tx).AddAlias(context.Background(), userID, "my correction", target.ID))

	// pins: a user's favorite.
	require.NoError(t, tx.Exec(
		"INSERT INTO pins (user_id, food_item_id, grams, meal_slot) VALUES (?, ?, ?, ?)",
		userID, target.ID, 100.0, "lunch").Error)

	// saved_meals + saved_meal_items: a saved meal containing the food.
	mealID := uuid.New()
	require.NoError(t, tx.Exec(
		"INSERT INTO saved_meals (id, user_id, name, meal_slot) VALUES (?, ?, ?, ?)",
		mealID, userID, "my meal", "dinner").Error)
	require.NoError(t, tx.Exec(
		"INSERT INTO saved_meal_items (saved_meal_id, food_item_id, grams, position) VALUES (?, ?, ?, ?)",
		mealID, target.ID, 150.0, 0).Error)

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	_, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.NoError(t, err)

	// The food row itself: still present, deleted_at now set.
	var deletedAtIsSet bool
	require.NoError(t, tx.Raw("SELECT deleted_at IS NOT NULL FROM food_items WHERE id = ?", target.ID).Scan(&deletedAtIsSet).Error)
	assert.True(t, deletedAtIsSet, "the food row must still exist, with deleted_at set — never gone")

	var aliasCount, pinCount, itemCount int64
	require.NoError(t, tx.Raw("SELECT count(*) FROM food_aliases WHERE food_item_id = ?", target.ID).Scan(&aliasCount).Error)
	require.NoError(t, tx.Raw("SELECT count(*) FROM pins WHERE food_item_id = ?", target.ID).Scan(&pinCount).Error)
	require.NoError(t, tx.Raw("SELECT count(*) FROM saved_meal_items WHERE food_item_id = ?", target.ID).Scan(&itemCount).Error)

	assert.Equal(t, int64(1), aliasCount, "a hard delete would have CASCADE-destroyed this taught correction")
	assert.Equal(t, int64(1), pinCount, "a hard delete would have CASCADE-destroyed this pin")
	assert.Equal(t, int64(1), itemCount, "a hard delete would have CASCADE-destroyed this saved-meal item")
}

// fakeFailingGeneration is an ai.Generation double whose BumpGeneration
// always fails, for Rider 4's "the DB write committed but the post-commit
// cache bump did not" tests. CurrentGeneration is never exercised by these
// tests and simply returns a fixed value.
type fakeFailingGeneration struct{}

func (fakeFailingGeneration) CurrentGeneration(context.Context) (int64, error) { return 1, nil }
func (fakeFailingGeneration) BumpGeneration(context.Context) error {
	return fmt.Errorf("fake: redis unreachable")
}

var _ ai.Generation = fakeFailingGeneration{}

// TestUpdateFoodRoundTripsCommittedUpdatedAtAcrossTwoSequentialEdits is
// Rider 1's round-trip proof: an updated_at handed back by one UpdateFood
// call is valid input to the NEXT UpdateFood call on the same row — exactly
// the read-then-PATCH cycle a real admin UI performs. Without this, a caller
// that always resubmits the FIRST updated_at it ever saw could never edit a
// row twice in a row.
func TestUpdateFoodRoundTripsCommittedUpdatedAtAcrossTwoSequentialEdits(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-roundtrip-updatedat-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	in := inputFrom(original)
	in.KcalPer100g = original.KcalPer100g + 1
	first, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.NoError(t, err, "the first edit, using the row's true current updated_at, must succeed")

	in2 := inputFrom(original)
	in2.KcalPer100g = original.KcalPer100g + 2
	second, err := repo.UpdateFood(context.Background(), actor, original.ID, in2, first.UpdatedAt)
	require.NoError(t, err, "the second edit, using the FIRST edit's own returned updated_at, must also succeed")
	assert.Equal(t, original.KcalPer100g+2, second.KcalPer100g)
}

// TestUpdateFoodStaleUpdatedAtIsRejectedAndLeavesTheRowAndAuditUntouched is
// TestUpdateFoodRoundTripsCommittedUpdatedAtAcrossTwoSequentialEdits's twin
// (Rider 1): a PATCH carrying an updated_at that is no longer current — a
// pre-edit value, because a second edit landed on the row in between — must
// be rejected with ErrStaleUpdate (mapped to 409 by the handler), and must
// leave BOTH the row and the audit trail exactly as the intervening edit
// left them.
func TestUpdateFoodStaleUpdatedAtIsRejectedAndLeavesTheRowAndAuditUntouched(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-stale-updatedat-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	staleUpdatedAt := loadUpdatedAt(t, tx, original.ID)

	in := inputFrom(original)
	in.KcalPer100g = original.KcalPer100g + 1
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, in, staleUpdatedAt)
	require.NoError(t, err, "the first, genuinely current-at-the-time edit must succeed")

	var eventCountBeforeStaleAttempt int64
	require.NoError(t, tx.Model(&AdminEvent{}).Where("target_id = ? AND action = ?", original.ID, ActionFoodUpdated).
		Count(&eventCountBeforeStaleAttempt).Error)

	staleIn := inputFrom(original)
	staleIn.KcalPer100g = original.KcalPer100g + 999
	_, err = repo.UpdateFood(context.Background(), actor, original.ID, staleIn, staleUpdatedAt)
	require.Error(t, err, "reusing the PRE-first-edit updated_at for a second PATCH must fail")
	assert.ErrorIs(t, err, ErrStaleUpdate)
	assert.NotErrorIs(t, err, gorm.ErrRecordNotFound,
		"a stale precondition on a row proven live and locked is never the missing/retired case")

	var kcal float64
	require.NoError(t, tx.Raw("SELECT kcal_per_100g FROM food_items WHERE id = ?", original.ID).Scan(&kcal).Error)
	assert.Equal(t, original.KcalPer100g+1, kcal, "the rejected stale PATCH must not have applied its values")

	var eventCountAfterStaleAttempt int64
	require.NoError(t, tx.Model(&AdminEvent{}).Where("target_id = ? AND action = ?", original.ID, ActionFoodUpdated).
		Count(&eventCountAfterStaleAttempt).Error)
	assert.Equal(t, eventCountBeforeStaleAttempt, eventCountAfterStaleAttempt,
		"the rejected stale PATCH must not have recorded a second audit event")
}

// TestUpdateFoodMissingUpdatedAtPreconditionIsRequired404sBeforeStaleCheck
// separates ErrRecordNotFound (missing/retired row) from ErrStaleUpdate
// (live row, wrong updated_at) at the repository layer — the handler is what
// turns the former into 404 and the latter into 409, but that mapping can
// only be correct if the two really are distinguishable here.
func TestUpdateFoodMissingRowIsRecordNotFoundNeverStaleUpdate(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	_, err := repo.UpdateFood(context.Background(), actor, uuid.New(), FoodInput{
		Name: "does-not-exist", ServingGrams: 1, KcalPer100g: 1,
	}, time.Now().UTC())
	require.Error(t, err)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound, "a nonexistent id must 404, never 409")
	assert.NotErrorIs(t, err, ErrStaleUpdate)
}

// TestCreateFoodRejectsDuplicateBarcodeIncludingAnAlreadyRetiredRow is
// Rider 2's in-transaction pre-check proof: idx_food_items_barcode
// (migration 000002) is NOT filtered on deleted_at, so a barcode belonging
// to an already soft-deleted row is still taken, and CreateFood must say so
// rather than silently creating a second row with a barcode the unique index
// will reject anyway with an opaque constraint error.
func TestCreateFoodRejectsDuplicateBarcodeIncludingAnAlreadyRetiredRow(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	barcode := "012345678905-" + uuid.NewString()
	existing := food("zzz-barcode-retired-owner-"+uuid.NewString(), "")
	existing.Barcode = &barcode
	require.NoError(t, tx.Create(&existing).Error)
	require.NoError(t, tx.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", existing.ID).Error)

	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	_, err := repo.CreateFood(context.Background(), actor, FoodInput{
		Name: "zzz-barcode-collider-" + uuid.NewString(), Provenance: nutrition.ProvenanceCurated,
		ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 100, Barcode: &barcode,
	})
	require.Error(t, err, "a barcode already owned by a retired row must still be rejected")
	assert.ErrorIs(t, err, ErrDuplicateBarcode)

	var foodCount int64
	require.NoError(t, tx.Model(&nutrition.FoodItem{}).Where("barcode = ?", barcode).Count(&foodCount).Error)
	assert.Equal(t, int64(1), foodCount, "the rejected create must not have inserted a second row")
}

// TestCreateFoodAcceptsAUniqueBarcode is the accept twin of
// TestCreateFoodRejectsDuplicateBarcodeIncludingAnAlreadyRetiredRow: a
// barcode nobody else owns must create successfully.
func TestCreateFoodAcceptsAUniqueBarcode(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	barcode := "unique-barcode-" + uuid.NewString()
	got, err := repo.CreateFood(context.Background(), actor, FoodInput{
		Name: "zzz-barcode-unique-" + uuid.NewString(), Provenance: nutrition.ProvenanceCurated,
		ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 100, Barcode: &barcode,
	})
	require.NoError(t, err)
	require.NotNil(t, got.Barcode)
	assert.Equal(t, barcode, *got.Barcode)
}

// TestCreateFoodConcurrentInsertsWithTheSameBarcodeRaceToOneWinner is
// Rider 2's SQLSTATE 23505 backstop proof: the in-transaction pre-check
// cannot see another transaction's uncommitted insert, so two concurrent
// creates for the same never-before-seen barcode can both pass the
// pre-check and then race at the INSERT itself. Exactly one must succeed;
// the other must come back as ErrDuplicateBarcode via the unwrapped
// *pgconn.PgError 23505, not an opaque 500.
func TestCreateFoodConcurrentInsertsWithTheSameBarcodeRaceToOneWinner(t *testing.T) {
	db := testDB(t)
	repo := NewMutationRepository(db, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}
	barcode := "race-barcode-" + uuid.NewString()

	results := make(chan error, 2)
	ids := make(chan uuid.UUID, 2)
	run := func(name string) {
		got, err := repo.CreateFood(context.Background(), actor, FoodInput{
			Name: name, Provenance: nutrition.ProvenanceCurated,
			ServingDesc: "1 serve", ServingGrams: 100, KcalPer100g: 100, Barcode: &barcode,
		})
		results <- err
		if err == nil {
			ids <- got.ID
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); run("zzz-barcode-race-a-" + uuid.NewString()) }()
	go func() { defer wg.Done(); run("zzz-barcode-race-b-" + uuid.NewString()) }()
	wg.Wait()
	close(results)
	close(ids)

	t.Cleanup(func() {
		db.Exec("DELETE FROM kora_admin_events WHERE target_id IN (SELECT id FROM food_items WHERE barcode = ?)", barcode)
		db.Exec("DELETE FROM food_items WHERE barcode = ?", barcode)
	})

	var succeeded, duplicateRejected int
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrDuplicateBarcode):
			duplicateRejected++
		default:
			t.Errorf("unexpected error from a concurrent create: %v", err)
		}
	}
	assert.Equal(t, 1, succeeded, "exactly one concurrent create for the same barcode must win")
	assert.Equal(t, 1, duplicateRejected, "the loser must be reported as ErrDuplicateBarcode, not an opaque failure")

	var barcodeCount int64
	require.NoError(t, db.Model(&nutrition.FoodItem{}).Where("barcode = ?", barcode).Count(&barcodeCount).Error)
	assert.Equal(t, int64(1), barcodeCount, "only the winner's row may exist")
}

// TestSoftDeleteFoodResponseCarriesRetirementFields is Rider 3's proof: the
// value SoftDeleteFood returns must be able to express that the food is now
// retired — id, name and a non-nil deleted_at at minimum — which
// nutrition.FoodItem (no DeletedAt field) could never do.
func TestSoftDeleteFoodResponseCarriesRetirementFields(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-response-shape-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, ai.NoCache{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	got, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.NoError(t, err)
	assert.Equal(t, target.ID, got.ID)
	assert.Equal(t, target.Name, got.Name)
	require.NotNil(t, got.DeletedAt, "a soft-deleted food's response must show it retired")
	assert.False(t, got.UpdatedAt.IsZero())
}

// TestUpdateFoodRendersSuccessDespiteCacheBumpFailureButSentinelIsDetectable
// is Rider 4's proof for UpdateFood: a post-commit cache-generation bump
// failure must not read as "the edit failed" — the DB write already
// committed — so UpdateFood still returns the updated FoodSnapshot (not a
// zero value) alongside an error the handler can recognise via
// errors.Is(err, ErrCacheGenerationBump) and render as a 2xx while logging
// server-side.
func TestUpdateFoodRendersSuccessDespiteCacheBumpFailureButSentinelIsDetectable(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-cachebumpfail-update-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, fakeFailingGeneration{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	in := inputFrom(original)
	in.KcalPer100g = original.KcalPer100g + 1
	got, err := repo.UpdateFood(context.Background(), actor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.Error(t, err, "a failed cache bump must still be surfaced as an error server-side")
	assert.ErrorIs(t, err, ErrCacheGenerationBump)
	assert.Equal(t, original.KcalPer100g+1, got.KcalPer100g,
		"the mutation itself committed — the returned snapshot must reflect the real, applied edit, not a zero value")

	var kcal float64
	require.NoError(t, tx.Raw("SELECT kcal_per_100g FROM food_items WHERE id = ?", original.ID).Scan(&kcal).Error)
	assert.Equal(t, original.KcalPer100g+1, kcal, "the DB write must have committed despite the cache bump failing")
}

// TestUpdateFoodGenuineTransactionFailureIsNotMistakenForACacheBumpFailure
// is the previous test's twin: when the TRANSACTION itself fails (audit
// CHECK violation), the error must NOT be ErrCacheGenerationBump, and the
// returned snapshot must be the zero value — the cache is never even reached
// because the transaction never committed.
func TestUpdateFoodGenuineTransactionFailureIsNotMistakenForACacheBumpFailure(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-realtxnfail-update-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, fakeFailingGeneration{})
	badActor := Actor{ID: "admin-1", Email: "   "}

	in := inputFrom(original)
	in.KcalPer100g = original.KcalPer100g + 1
	got, err := repo.UpdateFood(context.Background(), badActor, original.ID, in, loadUpdatedAt(t, tx, original.ID))
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrCacheGenerationBump,
		"a transaction that never committed must not be reported as a cache-bump failure")
	assert.Equal(t, FoodSnapshot{}, got, "a genuine transaction failure must return the zero value, not a partial snapshot")
}

// TestSoftDeleteFoodRendersSuccessDespiteCacheBumpFailureButSentinelIsDetectable
// is Rider 4's proof for SoftDeleteFood, the same shape as UpdateFood's.
func TestSoftDeleteFoodRendersSuccessDespiteCacheBumpFailureButSentinelIsDetectable(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	target := seedFoodTx(t, tx, "zzz-cachebumpfail-delete-"+uuid.NewString(), "")
	repo := NewMutationRepository(tx, fakeFailingGeneration{})
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	got, err := repo.SoftDeleteFood(context.Background(), actor, target.ID)
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrCacheGenerationBump)
	require.NotNil(t, got.DeletedAt, "the retirement itself committed — the returned snapshot must show it retired, not a zero value")

	var deletedAtIsSet bool
	require.NoError(t, tx.Raw("SELECT deleted_at IS NOT NULL FROM food_items WHERE id = ?", target.ID).Scan(&deletedAtIsSet).Error)
	assert.True(t, deletedAtIsSet, "the DB write must have committed despite the cache bump failing")
}
