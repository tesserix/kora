package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// recordingCache is a real ai.Cache that ALSO implements ai.Generation and
// counts its bumps — the same dual role RedisCache plays in production. It
// embeds ai.NoCache for Get/Set/Delete so this file only has to state the
// part it is actually testing.
type recordingCache struct {
	ai.NoCache
	bumps atomic.Int64
}

func (c *recordingCache) CurrentGeneration(context.Context) (int64, error) {
	return c.bumps.Load(), nil
}

func (c *recordingCache) BumpGeneration(context.Context) error {
	c.bumps.Add(1)
	return nil
}

var _ ai.Generation = (*recordingCache)(nil)

// nonGenerationalCache is a cache with NO generation surface — the shape that
// must degrade loudly rather than silently.
//
// It implements Cache's three methods BY HAND and deliberately does NOT embed
// ai.NoCache: NoCache satisfies ai.Generation too (that is the whole point of
// it), so embedding it would make this fixture generational and both tests
// below would pass through the type-assertion branch they exist to bypass —
// green, and proving nothing. A mutation making the degradation path panic
// went undetected until this was fixed.
type nonGenerationalCache struct{}

func (nonGenerationalCache) Get(context.Context, string) (*ai.Resolution, bool) { return nil, false }
func (nonGenerationalCache) Set(context.Context, string, ai.Resolution)         {}
func (nonGenerationalCache) Delete(context.Context, string) error               { return nil }
func (nonGenerationalCache) DeleteByUser(context.Context, uuid.UUID) error      { return nil }

var (
	_ ai.Cache = nonGenerationalCache{}
	// The assertion that gives this fixture its meaning. There is no
	// compile-time way to say "does NOT implement ai.Generation", so
	// TestNonGenerationalCacheFixtureReallyHasNoGenerationSurface below
	// asserts it at runtime instead.
	_ ai.Cache = (*recordingCache)(nil)
)

// THE HAZARD TASK 3'S REVIEWER FLAGGED, pinned directly: the admin bump path
// must narrow the cache it was GIVEN, never construct one of its own. Pointer
// identity is the assertion — a second RedisCache would satisfy the
// ai.Generation type perfectly and differ only in identity, which is exactly
// why a type check here would prove nothing.
func TestResolveGenerationReturnsTheIdenticalInstanceItWasGiven(t *testing.T) {
	cache := &recordingCache{}
	assert.Same(t, cache, resolveGeneration(cache),
		"the generation surface must be the SAME instance the resolver reads from, not a new one")
}

// A nil cache (resolve engine disabled, or Redis unreachable at startup) must
// still yield a usable, no-op Generation — the admin surface has to mount
// regardless. Asserted through a real call, not just non-nilness: a typed-nil
// interface would pass a nil check here and panic on the first mutation.
func TestResolveGenerationDegradesToANoOpForANilCache(t *testing.T) {
	g := resolveGeneration(nil)
	require.NotNil(t, g)
	assert.NoError(t, g.BumpGeneration(t.Context()))
}

// The guard on the fixture itself. Everything below depends on
// nonGenerationalCache genuinely lacking a generation surface, and the way
// that silently stops being true is someone embedding ai.NoCache into it for
// convenience — NoCache satisfies ai.Generation, so the fixture would keep
// compiling, keep passing, and stop testing the degradation path entirely.
func TestNonGenerationalCacheFixtureReallyHasNoGenerationSurface(t *testing.T) {
	var c ai.Cache = nonGenerationalCache{}
	_, ok := c.(ai.Generation)
	require.False(t, ok, "the fixture must NOT implement ai.Generation, or the two tests below prove nothing")
}

// The twin: a REAL cache with no generation surface also degrades to a no-op
// rather than panicking or taking the food editor offline.
func TestResolveGenerationDegradesToANoOpForANonGenerationalCache(t *testing.T) {
	g := resolveGeneration(nonGenerationalCache{})
	require.NotNil(t, g)
	assert.NoError(t, g.BumpGeneration(t.Context()))
}

// THE END-TO-END IDENTITY PROOF, and the one the task brief asks for: the
// cache instance handed to server.Deps.ResolveCache — the same variable
// main.go passes to ai.NewResolver — is the instance an admin mutation
// actually bumps. Nothing structural forces this: the mutation path takes an
// ai.Generation, the resolve path takes an ai.Cache, and RedisCache satisfies
// both, so a second instance on a different Redis DB index would type-check
// everywhere and silently never invalidate anything.
//
// It drives a real signed DELETE through the real router against a real row,
// so it proves the whole chain — Deps → resolveGeneration →
// NewMutationRepository → SoftDeleteFood's post-commit bump — not just the
// helper in isolation.
func TestAdminMutationBumpsTheSameCacheInstanceWiredIntoDeps(t *testing.T) {
	db := testDB(t)
	cache := &recordingCache{}
	key := []byte(adminTestKey)

	// A COMMITTED row, not a seedTx one: SoftDeleteFood opens its own
	// transaction on db, so a row living inside this test's uncommitted
	// transaction would be invisible to it and the delete would 404.
	item := nutrition.FoodItem{
		Name:           "zzz-admin-cache-identity-" + uuid.NewString(),
		NormalizedName: "zzz-admin-cache-identity",
		Provenance:     nutrition.ProvenanceCurated,
		ServingDesc:    "1 serve",
		ServingGrams:   100,
		KcalPer100g:    100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() {
		// Unscoped hard delete: the mutation under test SOFT-deletes this
		// row, and a soft-deleted row left behind would accumulate in the
		// shared local database on every run.
		db.Unscoped().Where("id = ?", item.ID).Delete(&nutrition.FoodItem{})
		db.Exec("DELETE FROM kora_admin_events WHERE target_id = ?", item.ID)
	})

	r := NewRouter(Deps{DB: db, Verifier: stubVerifier{}, ResolveCache: cache, BFFHMACKey: key})

	path := "/v1/admin/foods/" + item.ID.String()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, path, ""))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, int64(1), cache.bumps.Load(),
		"the retirement must bump the SAME cache instance wired into Deps, or the resolver keeps serving the retired food for up to 24h")
}

// The negative twin, and the reason the assertion above is worth its weight:
// with a cache that has no generation surface the mutation still SUCCEEDS
// (the food is genuinely retired) — it simply cannot invalidate anything.
// That is the exact silent failure resolveGeneration's WARN exists to make
// visible, and pinning it here stops a future refactor from turning the
// degradation into a 500 or, worse, into a mutation that rolls back.
func TestAdminMutationStillSucceedsWithANonGenerationalCache(t *testing.T) {
	db := testDB(t)
	key := []byte(adminTestKey)

	item := nutrition.FoodItem{
		Name:           "zzz-admin-nogen-" + uuid.NewString(),
		NormalizedName: "zzz-admin-nogen",
		Provenance:     nutrition.ProvenanceCurated,
		ServingDesc:    "1 serve",
		ServingGrams:   100,
		KcalPer100g:    100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() {
		db.Unscoped().Where("id = ?", item.ID).Delete(&nutrition.FoodItem{})
		db.Exec("DELETE FROM kora_admin_events WHERE target_id = ?", item.ID)
	})

	r := NewRouter(Deps{DB: db, Verifier: stubVerifier{}, ResolveCache: nonGenerationalCache{}, BFFHMACKey: key})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, "/v1/admin/foods/"+item.ID.String(), ""))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var deletedAt *string
	require.NoError(t, db.Raw("SELECT deleted_at FROM food_items WHERE id = ?", item.ID).Scan(&deletedAt).Error)
	assert.NotNil(t, deletedAt, "the retirement must have committed even though nothing could be invalidated")
}

// A router built with NO cache at all must still mount and serve mutations —
// the admin food editor cannot be gated on Redis being up.
func TestAdminMutationsMountWithoutAnyResolveCache(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: []byte(adminTestKey)})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/v1/admin/foods/"+uuid.NewString(), nil))
	assert.Equal(t, http.StatusUnauthorized, w.Code,
		"mounted (401 for an unsigned call), not 404 — a missing cache must not unmount the surface")
}
