package admin

import (
	"context"
	"sync"
	"testing"

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
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, macrosOnly)
	require.NoError(t, err)
	assert.True(t, hasEmbedding(t, tx, original.ID), "a macros-only edit must NOT null the embedding")

	// Rename.
	renamed := inputFrom(original)
	renamed.Name = "zzz-embed-renamed-" + uuid.NewString()
	renamed.KcalPer100g = 999
	_, err = repo.UpdateFood(context.Background(), actor, original.ID, renamed)
	require.NoError(t, err)
	assert.False(t, hasEmbedding(t, tx, original.ID), "a rename must null the embedding in the same statement")
}

// TestUpdateFoodBumpsCacheGenerationOnMacrosChangeButNotOnNoOp is invariant 3
// and its twin: a macros edit must bump, an edit that changes nothing about
// the macros must not.
func TestUpdateFoodBumpsCacheGenerationOnMacrosChangeButNotOnNoOp(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)
	original := seedFoodTx(t, tx, "zzz-cachebump-"+uuid.NewString(), "")

	cache := &fakeGeneration{}
	repo := NewMutationRepository(tx, cache)
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	// No-op edit: every field identical to what's already stored.
	_, err := repo.UpdateFood(context.Background(), actor, original.ID, inputFrom(original))
	require.NoError(t, err)
	assert.Equal(t, 0, cache.Bumps(), "an edit that changes nothing about the macros must not bump the cache generation")

	// Macros edit.
	macrosChanged := inputFrom(original)
	macrosChanged.ProteinPer100g = original.ProteinPer100g + 5
	_, err = repo.UpdateFood(context.Background(), actor, original.ID, macrosChanged)
	require.NoError(t, err)
	assert.Equal(t, 1, cache.Bumps(), "a macros edit must bump the cache generation exactly once")
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
