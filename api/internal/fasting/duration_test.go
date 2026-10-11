package fasting

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func at(h int) time.Time {
	return time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC).Add(time.Duration(h) * time.Hour)
}
func ptr(t time.Time) *time.Time { return &t }

func TestHoursUsesTheExplicitEndWhenItIsEarliest(t *testing.T) {
	i := Interval{StartedAt: at(0), EndedAt: ptr(at(16))}
	require.InDelta(t, 16, Hours(i, nil, at(40)), 0.001)
}

func TestHoursUsesTheFirstFoodLogWhenItIsEarliest(t *testing.T) {
	// Eating IS the end of a fast. No explicit end was tapped.
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, 14, Hours(i, ptr(at(14)), at(40)), 0.001)
}

func TestHoursIgnoresAFoodLogBeforeTheFastStarted(t *testing.T) {
	i := Interval{StartedAt: at(10)}
	require.InDelta(t, 5, Hours(i, ptr(at(3)), at(15)), 0.001,
		"a log from before the fast began cannot have ended it")
}

func TestHoursCapsAnAbandonedFast(t *testing.T) {
	// Open, never ended, no food logged, and the user stopped opening the app.
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, CapHours, Hours(i, nil, at(500)), 0.001,
		"an abandoned fast must plateau, not accrue forever")
}

func TestHoursOfAnOpenFastIsItsDurationSoFar(t *testing.T) {
	i := Interval{StartedAt: at(0)}
	require.InDelta(t, 30, Hours(i, nil, at(30)), 0.001,
		"a running fast counts now; waiting for an end would never notice the long ones")
}

func TestHoursNeverNegative(t *testing.T) {
	i := Interval{StartedAt: at(10)}
	require.InDelta(t, 0, Hours(i, nil, at(5)), 0.001,
		"a clock skew must not produce a negative fast")
}
