package ai

import (
	"context"
	"os"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// testDB opens a real Postgres connection for integration tests, skipping
// (never failing) the test if Postgres is unavailable — Resolver's core
// invariant guard can only be proven against real nutrition-index rows.
func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedTestUser inserts a bare user row (ai_usage_events.user_id has an FK to
// users) and schedules its cleanup.
func seedTestUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "resolver-"+id.String(), "resolver-"+id.String()+"@test.dev").Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM ai_usage_events WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

// seedAlias inserts an exact-match alias for a food item directly (bypassing
// the ingestion/correction pipeline), giving tests a deterministic
// MatchScore of 1.0 instead of depending on full-text ranking internals.
func seedAlias(t *testing.T, db *gorm.DB, alias string, foodItemID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		"INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", alias, foodItemID).Error)
}

// stubMeter is a configurable billing.Meter test double. It is defined
// locally (not billing.Meter) because package billing imports package ai for
// ai.Usage — Resolver depends on the local Meter interface instead, which
// billing.Meter satisfies structurally at the call site where Resolver is
// actually constructed in production wiring.
type stubMeter struct {
	withinBudget    bool
	withinBudgetErr error

	recordErr error
	records   []Usage
}

func (m *stubMeter) Record(ctx context.Context, userID uuid.UUID, u Usage, costUSD float64) error {
	m.records = append(m.records, u)
	return m.recordErr
}

func (m *stubMeter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	return m.withinBudget, m.withinBudgetErr
}

var _ Meter = (*stubMeter)(nil)

func seedFoodItem(t *testing.T, repo nutrition.Repository, item nutrition.FoodItem) nutrition.FoodItem {
	t.Helper()
	_, err := repo.Insert(context.Background(), []nutrition.FoodItem{item})
	require.NoError(t, err)

	var got nutrition.FoodItem
	items, err := repo.Search(context.Background(), item.Name, 5)
	require.NoError(t, err)
	for _, it := range items {
		if it.Brand == item.Brand && it.Name == item.Name {
			got = it
			break
		}
	}
	require.NotEqual(t, uuid.Nil, got.ID, "seeded food item must be findable by Search")
	return got
}

// TestResolveText_InvariantGuard_KcalComesOnlyFromTheRow is THE hard
// invariant test. The stub provider's Guess carries only Food/PortionEstimate
// /Confidence/CookingMethod — there is no field on Guess through which a
// number could reach Resolution.Candidates[0].Kcal. The only source of a
// kcal number in the resolver is FoodItem.KcalPer100g × grams / 100. This
// test seeds a FoodItem with a known KcalPer100g, feeds a Guess for the same
// food, and asserts the resolved Kcal equals exactly what the row's
// KcalPer100g implies for the parsed portion — proving the number came from
// the nutrition index, not from the (kcal-less) LLM guess.
func TestResolveText_InvariantGuard_KcalComesOnlyFromTheRow(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled chicken breast", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "grilled chicken breast", item.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)
	userID := uuid.New()

	res, err := resolver.ResolveText(context.Background(), userID, "grilled chicken breast")

	require.NoError(t, err)
	require.Equal(t, TierAuto, res.Tier)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 100.0, res.Candidates[0].PortionGrams)
	// 165 kcal/100g * 100g / 100 = 165 — computed from the row, never from
	// the (kcal-less) Guess.
	require.Equal(t, 165.0, res.Candidates[0].Kcal)
	require.Equal(t, item.KcalPer100g, res.Candidates[0].Item.KcalPer100g)
	require.NotEmpty(t, meter.records, "provider usage must be metered")
}

// TestResolveText_WeakConfidence_FollowUpWhenDecomposeYieldsNothing covers a
// resolvable-but-weak match: the alias gives a perfect MatchScore, but the
// guess's own identify confidence is low, so TierFor's min() rule pulls the
// overall tier down to follow_up. Decompose is configured to return nothing
// resolvable, so the resolver must fall back to the original follow-up
// Resolution (with its question) rather than fabricate an estimate.
func TestResolveText_WeakConfidence_FollowUpWhenDecomposeYieldsNothing(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Weak match snack", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 200,
	})
	seedAlias(t, db, "weak match snack", item.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "weak match snack", PortionEstimate: "100 g", Confidence: 0.3},
		},
		guessUsage:  Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: nil, // Decompose yields nothing resolvable.
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "weak match snack")

	require.NoError(t, err)
	require.Equal(t, TierFollowUp, res.Tier)
	require.NotEmpty(t, res.FollowUpQuestion)
	require.False(t, res.IsEstimate)
}

// TestResolveText_UnknownDish_DecomposesToEstimate covers a dish that
// doesn't resolve at all on the first pass (a nonce phrase matching nothing
// in the index) but whose ingredients, once decomposed, DO resolve. The
// resulting Resolution must be a summed estimate with a low/high band,
// entirely from ingredient rows.
func TestResolveText_UnknownDish_DecomposesToEstimate(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	chicken := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Shredded chicken ingredient", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "shredded chicken 2b", chicken.ID)

	rice := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Steamed rice ingredient", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "steamed rice 2b", rice.ID)

	provider := &stubProvider{
		guesses: []Guess{
			// Nonce token that no seeded or ambient row contains — guaranteed
			// zero matches across alias/full-text/embedding tiers.
			{Food: "qzzznonce unknown dish 2b", PortionEstimate: "1 serving", Confidence: 0.9},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "shredded chicken 2b", PortionEstimate: "150 g", Confidence: 0.8},
			{Ingredient: "steamed rice 2b", PortionEstimate: "200 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce unknown dish 2b")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Less(t, res.KcalLow, res.KcalHigh)
	// 165*150/100 + 130*200/100 = 247.5 + 260 = 507.5
	wantSum := 507.5
	require.InDelta(t, wantSum*(1-estimateBand), res.KcalLow, 0.01)
	require.InDelta(t, wantSum*(1+estimateBand), res.KcalHigh, 0.01)
	require.Len(t, res.Candidates, 2)
}

// TestResolveText_BudgetExceeded_GracefulManualFallback verifies the budget
// gate returns a graceful, error-free manual-fallback Resolution and never
// even reaches the provider.
func TestResolveText_BudgetExceeded_GracefulManualFallback(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)

	provider := &stubProvider{
		guesses:    []Guess{{Food: "should not be reached", Confidence: 0.99}},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: false}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "anything")

	require.NoError(t, err)
	require.Equal(t, TierFollowUp, res.Tier)
	require.Equal(t, "budget", res.Provenance)
	require.NotEmpty(t, res.FollowUpQuestion)
	require.Equal(t, 0, provider.calls, "provider must never be called once over budget")
}

// TestResolveText_CachesResolution_SkipsProviderOnSecondCall proves the
// happy-path result is cached and a repeat request for the same phrase never
// re-invokes the provider.
func TestResolveText_CachesResolution_SkipsProviderOnSecondCall(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Cached grilled chicken", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "cached grilled chicken", item.ID)

	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	cache := NewRedisCache(client, 0)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "cached grilled chicken", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, cache, meter)
	ctx := context.Background()

	first, err := resolver.ResolveText(ctx, uuid.New(), "cached grilled chicken")
	require.NoError(t, err)
	callsAfterFirst := provider.calls // IdentifyText + Embed(per guess)
	require.Greater(t, callsAfterFirst, 0)

	second, err := resolver.ResolveText(ctx, uuid.New(), "cached grilled chicken")
	require.NoError(t, err)
	require.Equal(t, callsAfterFirst, provider.calls, "second call must be served from cache")
	require.Equal(t, first.Tier, second.Tier)
	require.Equal(t, first.Candidates[0].Kcal, second.Candidates[0].Kcal)
}
