package progress

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type stubLogs struct {
	days []string
	kcal map[string]float64
}

func (s stubLogs) LoggedDaysDesc(_ context.Context, _ uuid.UUID, _ time.Time, _ *time.Location, _ int) ([]string, error) {
	return s.days, nil
}
func (s stubLogs) DailyKcal(_ context.Context, _ uuid.UUID, _, _ time.Time, _ *time.Location) (map[string]float64, error) {
	return s.kcal, nil
}

func TestComputeStreakAndAdherenceBand(t *testing.T) {
	loc := time.UTC
	day := time.Date(2026, 4, 10, 15, 0, 0, 0, loc) // endDay = 2026-04-10
	stub := stubLogs{
		days: []string{"2026-04-10", "2026-04-09", "2026-04-07"}, // gap at 04-08 breaks streak at 2
		kcal: map[string]float64{
			"2026-04-10": 2000, // exactly on target -> in band
			"2026-04-09": 2200, // +10% exactly -> in band (<=)
			"2026-04-08": 2201, // just over +10% -> out
			"2026-04-07": 1000, // under -> out
		},
	}
	m, err := Compute(context.Background(), stub, uuid.New(), 2000, day, loc)
	require.NoError(t, err)
	require.Equal(t, 2, m.StreakDays)
	require.Equal(t, 2, m.AdherenceDays)
	require.Equal(t, 7, m.AdherenceWindow)
}

func TestComputeZeroTargetHasNoAdherence(t *testing.T) {
	loc := time.UTC
	day := time.Date(2026, 4, 10, 15, 0, 0, 0, loc)
	stub := stubLogs{days: []string{"2026-04-10"}, kcal: map[string]float64{"2026-04-10": 1500}}
	m, err := Compute(context.Background(), stub, uuid.New(), 0, day, loc)
	require.NoError(t, err)
	require.Equal(t, 1, m.StreakDays)
	require.Equal(t, 0, m.AdherenceDays)
}
