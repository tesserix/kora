package localday_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/localday"
)

func sydney(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Australia/Sydney")
	require.NoError(t, err)
	return loc
}

// Absent is NOT invalid. An already-installed build sends no local_date and
// must keep working exactly as before, rather than have every write rejected.
func TestResolveFallsBackToProfileZoneWhenAbsent(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC) // 13:00 in Sydney
	got, err := localday.Resolve("", loggedAt, sydney(t))
	require.NoError(t, err)
	require.Equal(t, "2026-03-01", got.Format("2006-01-02"))
}

// The whole point of kora#84: the client's value WINS over what the server
// would have computed from the profile zone. This is the test that fails if
// someone later "simplifies" this to server-side computation.
func TestResolvePrefersClientDateOverProfileZone(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC)
	// Device was in Los Angeles: 2026-02-28 local, though Sydney says 03-01.
	got, err := localday.Resolve("2026-02-28", loggedAt, sydney(t))
	require.NoError(t, err)
	require.Equal(t, "2026-02-28", got.Format("2006-01-02"))
}

// +/-1 day is the legitimate range: no single UTC date is "correct", because a
// real timezone can put the local date on either side of it.
func TestResolveAcceptsExactlyOneDayEitherSide(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	for _, in := range []string{"2026-02-28", "2026-03-01", "2026-03-02"} {
		got, err := localday.Resolve(in, loggedAt, sydney(t))
		require.NoError(t, err, in)
		require.Equal(t, in, got.Format("2006-01-02"))
	}
}

func TestResolveRejectsOutOfWindowDate(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	_, err := localday.Resolve("2026-03-09", loggedAt, sydney(t))
	require.Error(t, err)
}

func TestResolveRejectsMalformedDate(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	_, err := localday.Resolve("01/03/2026", loggedAt, sydney(t))
	require.Error(t, err)
}

// A nil location must not panic. ResolveMiddleware returns time.UTC when it
// cannot resolve one, but a direct caller could still pass nil.
func TestResolveTreatsNilLocationAsUTC(t *testing.T) {
	loggedAt := time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC)
	got, err := localday.Resolve("", loggedAt, nil)
	require.NoError(t, err)
	require.Equal(t, "2026-03-01", got.Format("2006-01-02"))
}
