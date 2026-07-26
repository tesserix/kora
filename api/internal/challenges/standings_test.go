package challenges

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/groups"
)

func TestStandingsRanksByScoreDescNameAsc(t *testing.T) {
	g, alice, bob := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	// alice 2 logged days, bob 1
	svc := NewService(store, stubGroups{m: member(g, alice, groups.RoleOwner)}, stubLogs{kcal: map[uuid.UUID]map[string]float64{
		alice: {"2026-07-01": 2000, "2026-07-02": 2000},
		bob:   {"2026-07-01": 2000},
	}})
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: alice, Title: "S", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 7)}
	store.find = &ch
	store.scoring = []ScoringRow{{ID: bob, DisplayName: "Bob", TargetKcal: 2000}, {ID: alice, DisplayName: "Alice", TargetKcal: 2000}}

	st, err := svc.Standings(context.Background(), ch.ID, time.UTC)
	require.NoError(t, err)
	require.Len(t, st, 2)
	require.Equal(t, "Alice", st[0].DisplayName)
	require.Equal(t, 2, st[0].Score)
	require.Equal(t, "Bob", st[1].DisplayName)
}

func TestStandingsUnknownChallengeNotFound(t *testing.T) {
	store := newStubStore()
	svc := NewService(store, stubGroups{}, stubLogs{})
	_, err := svc.Standings(context.Background(), uuid.New(), time.UTC)
	require.ErrorIs(t, err, ErrNotFound)
}
