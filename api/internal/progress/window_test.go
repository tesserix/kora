package progress

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestWindowScoreLoggedCountsDistinctDays(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 7, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{
		"2026-07-01": 1500, "2026-07-03": 2000, "2026-07-07": 1800,
	}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "logged", 2000, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 3, n)
}

func TestWindowScoreOnTargetInclusiveBand(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{
		"2026-07-01": 2000, // exactly on target -> in
		"2026-07-02": 2200, // +10% exactly -> in (<=)
		"2026-07-03": 2201, // just over +10% -> out
		"2026-07-04": 1500, // under -> out
	}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "on_target", 2000, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 2, n)
}

func TestWindowScoreZeroTargetIsZero(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)
	stub := stubLogs{kcal: map[string]float64{"2026-07-01": 1500, "2026-07-02": 1600}}
	n, err := WindowScore(context.Background(), stub, uuid.New(), "on_target", 0, from, to, loc)
	require.NoError(t, err)
	require.Equal(t, 0, n)
}

func TestWindowScoreUnknownMetricErrors(t *testing.T) {
	loc := time.UTC
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	_, err := WindowScore(context.Background(), stubLogs{}, uuid.New(), "bogus", 2000, from, from, loc)
	require.Error(t, err)
}
