package admin

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRecordEventWritesAttributionActionAndSnapshots pins the basic shape of
// a written kora_admin_events row: attribution columns come from Actor (not
// from before/after), and before/after round-trip as the jsonb the caller
// passed in.
func TestRecordEventWritesAttributionActionAndSnapshots(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)

	targetID := uuid.New()
	actor := Actor{ID: "admin-42", Email: "ops@kora.test"}
	before := map[string]any{"kcal_per_100g": 100.0}
	after := map[string]any{"kcal_per_100g": 150.0}

	require.NoError(t, recordEvent(tx, actor, ActionFoodUpdated, TargetTypeFood, targetID, before, after))

	var got AdminEvent
	require.NoError(t, tx.Where("target_id = ?", targetID).First(&got).Error)

	assert.Equal(t, actor.ID, got.ActorID)
	assert.Equal(t, actor.Email, got.ActorEmail)
	assert.Equal(t, ActionFoodUpdated, got.Action)
	assert.Equal(t, TargetTypeFood, got.TargetType)
	require.NotNil(t, got.TargetID)
	assert.Equal(t, targetID, *got.TargetID)

	var gotBefore, gotAfter map[string]any
	require.NoError(t, json.Unmarshal(got.Before, &gotBefore))
	require.NoError(t, json.Unmarshal(got.After, &gotAfter))
	assert.Equal(t, 100.0, gotBefore["kcal_per_100g"])
	assert.Equal(t, 150.0, gotAfter["kcal_per_100g"])

	// The discriminating assertion for "actor lives in its own columns, not
	// folded into the snapshots": neither snapshot must carry actor_id or
	// actor_email keys, or a caller reading `before`/`after` back would have
	// to know to ignore them.
	_, beforeHasActor := gotBefore["actor_id"]
	_, afterHasActor := gotAfter["actor_id"]
	assert.False(t, beforeHasActor, "before snapshot must not carry the actor")
	assert.False(t, afterHasActor, "after snapshot must not carry the actor")
}

// TestRecordEventNilBeforeStoresSQLNull covers CreateFood's case: there is no
// prior state, so `before` must be a real SQL NULL, not the JSON literal
// "null" — a caller doing `before IS NULL` in SQL to find creation events
// must see NULL, not a truthy jsonb scalar.
func TestRecordEventNilBeforeStoresSQLNull(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)

	targetID := uuid.New()
	actor := Actor{ID: "admin-1", Email: "ops@kora.test"}

	require.NoError(t, recordEvent(tx, actor, ActionFoodCreated, TargetTypeFood, targetID, nil, map[string]any{"name": "new food"}))

	var isNull bool
	require.NoError(t, tx.Raw("SELECT before IS NULL FROM kora_admin_events WHERE target_id = ?", targetID).Scan(&isNull).Error)
	assert.True(t, isNull, "a nil `before` must store SQL NULL, not the JSON literal null")
}

// TestRecordEventRejectsBlankActorEmail pins the CHECK constraint's job
// (migration 000023): a whitespace-only actor email must fail the INSERT,
// not silently store an unattributed row. This is also the mechanism
// TestCreateFoodAuditFailureRollsBackMutation (mutations_test.go) relies on
// to force the audit half of a mutation to fail.
func TestRecordEventRejectsBlankActorEmail(t *testing.T) {
	db := testDB(t)
	tx := seedTx(t, db)

	err := recordEvent(tx, Actor{ID: "admin-1", Email: "   "}, ActionFoodCreated, TargetTypeFood, uuid.New(), nil, nil)
	require.Error(t, err, "a whitespace-only actor email must violate the actor_email CHECK constraint")
}
