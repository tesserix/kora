package foodlog

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// TestCreateBatchDoesNotNeedASecondConnection is the regression test for
// kora#415, the sibling of kora#413.
//
// CreateBatch opens a transaction -- one connection -- and then, inside it,
// resolves each item through nutrition.Repository. While that repository was
// bound to the POOL rather than to the transaction, every batch log held one
// connection and then blocked waiting for a second. maxOpenConns is 5 and
// every endpoint shares that pool, so five concurrent batch logs stalled the
// whole API, not just food logging.
//
// The connection is PINNED rather than raced for. Concurrency would prove the
// same property, but only if the requests actually overlapped -- and
// kora#407's concurrency test learned the hard way that a goroutine race
// against a fast local Postgres usually does not overlap at all, passing
// while exercising nothing. Pinning asserts the count directly: with a pool
// of two and one connection held by the test, exactly one is free, so a
// CreateBatch that completes is a CreateBatch that needed exactly one.
//
// The pool cap is load-bearing. The default testDB pool is unbounded, which
// is why the existing batch tests are all green under the bug: a request that
// wants two connections simply takes two.
func TestCreateBatchDoesNotNeedASecondConnection(t *testing.T) {
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(2)

	userID := seedUser(t, db)
	item := nutrition.FoodItem{
		Name: "Pool Batch " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	// Pin one of the two connections for the duration, leaving exactly one.
	pinCtx, pinCancel := context.WithCancel(context.Background())
	defer pinCancel()
	pinned, err := sqlDB.Conn(pinCtx)
	require.NoError(t, err)
	defer pinned.Close()

	// A deadline, not an open-ended wait: under the bug this call blocks
	// forever, and a hung test reports nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Two items, because the resolve happens once per item -- the batch holds
	// its transaction across the whole loop.
	logs, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{
			{FoodItemID: item.ID, QuantityGrams: 100},
			{FoodItemID: item.ID, QuantityGrams: 150},
		},
	}, nil)
	require.NoError(t, err,
		"CreateBatch must not wait on a connection it is itself holding -- "+
			"with only one connection free this is the kora#415 stall")
	require.Len(t, logs, 2)
}
