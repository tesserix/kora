package challenges

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestDueForStartAndMark(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Started", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })

	today := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	due, err := repo.ListDueForStart(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(due, ch.ID))

	require.NoError(t, repo.MarkStartedNotified(context.Background(), ch.ID))
	due, err = repo.ListDueForStart(context.Background(), today)
	require.NoError(t, err)
	require.False(t, containsID(due, ch.ID), "marked challenge no longer due for start")
}

func TestDueForEndAndActive(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ended, err := repo.Create(context.Background(), gid, owner, "Ended", MetricLogged, start, start.AddDate(0, 0, 5)) // ends 2026-07-06
	require.NoError(t, err)
	active, err := repo.Create(context.Background(), gid, owner, "Active", MetricLogged, start, start.AddDate(0, 0, 40)) // ends 2026-08-10
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	today := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	dueEnd, err := repo.ListDueForEnd(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(dueEnd, ended.ID))
	require.False(t, containsID(dueEnd, active.ID))

	act, err := repo.ListActive(context.Background(), today)
	require.NoError(t, err)
	require.True(t, containsID(act, active.ID))
	require.False(t, containsID(act, ended.ID))
}

func TestParticipantIDsRanksRoundTrip(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db, "Owner", 2000)
	other := seedUser(t, db, "Other", 1800)
	gid := seedGroup(t, db, owner)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Ranks", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE id = ?", ch.ID) })
	require.NoError(t, repo.AddParticipant(context.Background(), ch.ID, other))

	ids, err := repo.ParticipantIDs(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Len(t, ids, 2)

	// initial ranks are nil
	ranks, err := repo.ParticipantRanks(context.Background(), ch.ID)
	require.NoError(t, err)
	require.Nil(t, ranks[owner])

	require.NoError(t, repo.SetLastRanks(context.Background(), ch.ID, map[uuid.UUID]int{owner: 1, other: 2}))
	ranks, err = repo.ParticipantRanks(context.Background(), ch.ID)
	require.NoError(t, err)
	require.NotNil(t, ranks[owner])
	require.Equal(t, 1, *ranks[owner])
	require.Equal(t, 2, *ranks[other])
}

func containsID(chs []Challenge, id uuid.UUID) bool {
	for _, c := range chs {
		if c.ID == id {
			return true
		}
	}
	return false
}
