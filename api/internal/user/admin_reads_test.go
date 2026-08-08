package user

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedAIUsageEventWithOutcome is seedAIUsageEvent plus an explicit outcome.
// It exists because TestListForAdminCountsFailedAICallsToo needs to seed a
// FAILED call specifically -- seedAIUsageEvent always writes the column
// default ('ok'), which can't exercise that path.
func seedAIUsageEventWithOutcome(t *testing.T, db *gorm.DB, userID uuid.UUID, outcome string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(`
		INSERT INTO ai_usage_events (id, user_id, provider, model, call_type, outcome)
		VALUES (?, ?, 'test', 'test-model', 'resolve', ?)`, id, userID, outcome).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM ai_usage_events WHERE id = ?`, id) })
	return id
}

// TestListForAdminSeparatesTriedFromNeverTried seeds three users into the
// shared test database (which already carries rows from other packages'
// tests and earlier tasks on this branch) and asserts ONLY on those three,
// looked up by id out of the full result set. Asserting on res.Summary.Users
// or a fixed slice index would be vacuous -- both depend on ambient rows
// this test does not control -- so the summary counters here are compared as
// DELTAS (before vs after seeding), and the per-row facts are read out of a
// byID map keyed on the ids this test seeded.
func TestListForAdminSeparatesTriedFromNeverTried(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)

	before, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)

	logger := seedUser(t, db)
	seedFoodLog(t, db, logger.ID)
	seedAIUsageEvent(t, db, logger.ID)

	tried := seedUser(t, db) // AI calls, no logs -- the cohort that matters
	seedAIUsageEvent(t, db, tried.ID)

	never := seedUser(t, db) // never tried anything

	res, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)

	assert.Equal(t, before.Summary.Users+3, res.Summary.Users, "three new users seeded")
	assert.Equal(t, before.Summary.EverLogged+1, res.Summary.EverLogged, "only the logger crossed the line")
	assert.Equal(t, before.Summary.TriedNeverLogged+1, res.Summary.TriedNeverLogged, "only the tried-and-failed user counts here")

	byID := map[uuid.UUID]AdminRow{}
	for _, r := range res.Items {
		byID[r.ID] = r
	}
	require.Contains(t, byID, logger.ID)
	require.Contains(t, byID, tried.ID)
	require.Contains(t, byID, never.ID)

	assert.Equal(t, int64(1), byID[tried.ID].AICalls)
	assert.Zero(t, byID[tried.ID].LogCount)
	assert.Equal(t, int64(1), byID[logger.ID].LogCount)
	assert.Equal(t, int64(1), byID[logger.ID].AICalls)
	assert.Zero(t, byID[never.ID].LogCount)
	assert.Zero(t, byID[never.ID].AICalls)
}

// TestListForAdminCountsFailedAICallsToo pins the single most important
// correctness rule in this endpoint: a failed AI call still counts toward
// ai_calls. Scoped to the one seeded user's row via byID, not res.Items[0]
// (which would be whatever row the shared database happens to order first).
func TestListForAdminCountsFailedAICallsToo(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	u := seedUser(t, db)
	seedAIUsageEventWithOutcome(t, db, u.ID, "error")

	res, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)

	byID := map[uuid.UUID]AdminRow{}
	for _, r := range res.Items {
		byID[r.ID] = r
	}
	require.Contains(t, byID, u.ID)
	// Filtering outcome='ok' here would erase the tried-and-failed cohort.
	assert.Equal(t, int64(1), byID[u.ID].AICalls)
	assert.Zero(t, byID[u.ID].LogCount)
}

// TestListForAdminHasTargetsReflectsOnboarding pins HasTargets against the
// real column semantics: target_kcal is NOT NULL DEFAULT 0
// (000002_phase1_core.up.sql), so a brand-new user's row must read false, and
// nothing here can ever observe a NULL. A future regression to "IS NOT NULL"
// would make this test fail because it would report true unconditionally.
func TestListForAdminHasTargetsReflectsOnboarding(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	u := seedUser(t, db)

	res, err := repo.ListForAdmin(context.Background())
	require.NoError(t, err)

	byID := map[uuid.UUID]AdminRow{}
	for _, r := range res.Items {
		byID[r.ID] = r
	}
	require.Contains(t, byID, u.ID)
	assert.False(t, byID[u.ID].HasTargets, "un-onboarded user has target_kcal = 0")
}
