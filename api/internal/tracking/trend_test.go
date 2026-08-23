package tracking

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func day(n int) time.Time {
	return time.Date(2026, 6, 1, 8, 0, 0, 0, time.UTC).AddDate(0, 0, n)
}

// A clean -0.5/week line over 4 weeks. Values are synthetic.
func TestWeeklyRateFitsASteadyDecline(t *testing.T) {
	points := []RatePoint{
		{At: day(0), Value: 80},
		{At: day(7), Value: 79.5},
		{At: day(14), Value: 79},
		{At: day(21), Value: 78.5},
		{At: day(28), Value: 78},
	}
	got, ok := WeeklyRate(points)
	require.True(t, ok)
	require.InDelta(t, -0.5, got.PerWeek, 0.0001)
	require.Equal(t, 5, got.Basis.Readings)
	require.Equal(t, 28, got.Basis.Days)
}

// OLS, not first-minus-last: one bloated reading must not define the slope.
func TestWeeklyRateIsNotDominatedBySingleOutlier(t *testing.T) {
	steady := []RatePoint{
		{At: day(0), Value: 80}, {At: day(7), Value: 79.5},
		{At: day(14), Value: 79}, {At: day(21), Value: 78.5},
		{At: day(28), Value: 78},
	}
	spiked := append([]RatePoint{}, steady...)
	spiked[len(spiked)-1] = RatePoint{At: day(28), Value: 81}

	base, _ := WeeklyRate(steady)
	out, ok := WeeklyRate(spiked)
	require.True(t, ok)
	// One bloated final reading does flip the sign either way -- the claim
	// OLS earns is that it is flipped LESS far. Last-minus-first hands the
	// whole slope to that one reading (+0.25/week); OLS gives +0.1/week,
	// because the three readings in between still pull on the fit.
	lastMinusFirst := (spiked[len(spiked)-1].Value - spiked[0].Value) / 4
	require.InDelta(t, 0.25, lastMinusFirst, 0.0001)
	require.Less(t, out.PerWeek, lastMinusFirst,
		"OLS must be swung less by a single outlier than last-minus-first")
	require.Greater(t, out.PerWeek, base.PerWeek)
}

func TestWeeklyRateRejectsTooFewReadings(t *testing.T) {
	_, ok := WeeklyRate([]RatePoint{
		{At: day(0), Value: 80}, {At: day(10), Value: 79}, {At: day(20), Value: 78},
	})
	require.False(t, ok, "3 readings is below the 4-reading gate")
}

func TestWeeklyRateRejectsTooShortASpan(t *testing.T) {
	_, ok := WeeklyRate([]RatePoint{
		{At: day(0), Value: 80}, {At: day(3), Value: 79.8},
		{At: day(6), Value: 79.6}, {At: day(10), Value: 79.4},
	})
	require.False(t, ok, "10 days is below the 14-day gate")
}

func TestWeeklyRateRejectsReadingsAllAtOneInstant(t *testing.T) {
	at := day(0)
	_, ok := WeeklyRate([]RatePoint{
		{At: at, Value: 80}, {At: at, Value: 80.1},
		{At: at, Value: 79.9}, {At: at, Value: 80.2},
	})
	require.False(t, ok, "zero time variance has no slope and must not divide by zero")
}
