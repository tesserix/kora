package coach

import (
	"context"
	"testing"

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
