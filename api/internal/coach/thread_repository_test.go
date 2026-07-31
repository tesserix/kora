package coach

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestThreadRepository_AppendAndListRoundTrip(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	err := repo.AppendExchange(ctx, userID, "what should I eat?", "more protein",
		[]Fact{{Label: "Protein today", Value: "65g"}, {Label: "Kcal left", Value: "750"}})
	require.NoError(t, err)

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)

	require.Equal(t, TurnRoleUser, turns[0].Role)
	require.Equal(t, "what should I eat?", turns[0].Text)
	require.Empty(t, turns[0].Citations, "user turns carry no citations")

	require.Equal(t, TurnRoleOtto, turns[1].Role)
	require.Equal(t, "more protein", turns[1].Text)
	require.Len(t, turns[1].Citations, 2)
	require.Equal(t, "Protein today", turns[1].Citations[0].Label)
	require.Equal(t, "65g", turns[1].Citations[0].Value)
	require.Equal(t, "Kcal left", turns[1].Citations[1].Label)
}

func TestThreadRepository_ListRecentIsOldestFirst(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.AppendExchange(ctx, userID, "q1", "a1", nil))
	require.NoError(t, repo.AppendExchange(ctx, userID, "q2", "a2", nil))

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 4)
	require.Equal(t, "q1", turns[0].Text)
	require.Equal(t, "a1", turns[1].Text)
	require.Equal(t, "q2", turns[2].Text)
	require.Equal(t, "a2", turns[3].Text)
}

func TestThreadRepository_ListRecentReturnsMostRecentWhenOverLimit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	// 30 exchanges == 60 turns, over the 50 cap.
	for i := 0; i < 30; i++ {
		require.NoError(t, repo.AppendExchange(ctx, userID, "q", "a", nil))
	}

	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, maxThreadTurns, "must cap at the limit")

	// The cap must keep the NEWEST turns, and still return them oldest-first.
	all, err := repo.ListRecent(ctx, userID, 1000)
	require.NoError(t, err)
	require.Len(t, all, 60)
	require.Equal(t, all[len(all)-1].CreatedAt.UnixMicro(), turns[len(turns)-1].CreatedAt.UnixMicro(),
		"last capped turn must be the newest turn overall")
}

// TestThreadRepository_OrdersBySeqNotCreatedAt exists to catch a regression
// where ListRecent's Order("seq DESC") is changed back to
// Order("created_at DESC", ...) or similar. Normally GORM's client-stamped
// CreatedAt values happen to increase in the same direction as seq, so the
// other tests in this file pass even if ListRecent orders by created_at
// instead of seq — they never force the two to disagree. This is the ONLY
// test in the package that would catch that regression: it forces
// created_at to run in the exact opposite direction of seq, then asserts
// ListRecent still replays in seq (insertion) order.
func TestThreadRepository_OrdersBySeqNotCreatedAt(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.AppendExchange(ctx, userID, "q1", "a1", nil))
	require.NoError(t, repo.AppendExchange(ctx, userID, "q2", "a2", nil))

	// Read rows back ordered by seq so we know each row's id and its
	// insertion order.
	var rows []Turn
	require.NoError(t, db.Where("user_id = ?", userID).Order("seq ASC").Find(&rows).Error)
	require.Len(t, rows, 4)

	// Assign created_at values strictly OPPOSITE to seq order: the highest
	// seq (last inserted, "a2") gets the OLDEST timestamp, the lowest seq
	// (first inserted, "q1") gets the NEWEST timestamp.
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, row := range rows {
		ts := base.Add(time.Duration(len(rows)-1-i) * time.Hour)
		require.NoError(t, db.Exec(
			"UPDATE coach_turns SET created_at = ? WHERE id = ?", ts, row.ID).Error)
	}

	// Confirm the setup UPDATE actually took effect and the timestamps are
	// really inverted relative to seq, so this test fails loudly if the
	// UPDATE silently did nothing instead of masking the real assertion.
	var reloaded []Turn
	require.NoError(t, db.Where("user_id = ?", userID).Order("seq ASC").Find(&reloaded).Error)
	require.Len(t, reloaded, 4)
	for i := 0; i < len(reloaded)-1; i++ {
		require.True(t, reloaded[i].CreatedAt.After(reloaded[i+1].CreatedAt),
			"setup invariant broken: created_at must strictly decrease as seq increases")
	}

	// ListRecent must still replay in seq (insertion) order — q1, a1, q2,
	// a2 — even though created_at order is the exact reverse.
	turns, err := repo.ListRecent(ctx, userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 4)
	require.Equal(t, "q1", turns[0].Text)
	require.Equal(t, "a1", turns[1].Text)
	require.Equal(t, "q2", turns[2].Text)
	require.Equal(t, "a2", turns[3].Text)
}

func TestThreadRepository_ScopedToUser(t *testing.T) {
	db := testDB(t)
	alice := seedUser(t, db, 2000, 120)
	bob := seedUser(t, db, 2000, 120)
	repo := NewThreadRepository(db)
	ctx := context.Background()

	require.NoError(t, repo.AppendExchange(ctx, alice, "alice q", "alice a", nil))

	turns, err := repo.ListRecent(ctx, bob, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "must never return another user's turns")
}
