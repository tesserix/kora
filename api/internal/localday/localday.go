// Package localday resolves which calendar day a logged row belongs to.
//
// kora#84: the day used to be derived at QUERY time from the user's current
// profile timezone, so changing that timezone silently re-bucketed history —
// fly Sydney to London and yesterday's dinner moved to a different day. The
// day is now decided once, here, at write time, and stored on the row.
package localday

import (
	"fmt"
	"time"

	"github.com/tesserix/kora/api/internal/httpx"
)

const layout = "2006-01-02"

// window is how far a client-supplied date may sit from logged_at's UTC date.
// One day either side, because a real timezone legitimately puts the local
// date on either side of the UTC one (UTC+14 through UTC-12). Anything wider
// is not a timezone, it is a broken or hostile client.
const window = 24 * time.Hour

// Resolve returns the calendar date to persist for a row logged at loggedAt.
//
// clientDate is the device-local date captured at the moment of logging. It is
// preferred over anything the server could compute, because the offline queue
// replays writes later and possibly from another zone — a meal captured in
// London and replayed after landing in Sydney must keep London's date. A
// server computing the date on receipt would stamp the replay, which is the
// exact bug this package exists to remove.
//
// An EMPTY clientDate is not an error: it means an older client, and falls
// back to the profile zone, which is precisely the previous behaviour. That
// keeps already-installed builds working instead of rejecting every write from
// a user who has not updated.
func Resolve(clientDate string, loggedAt time.Time, loc *time.Location) (time.Time, error) {
	if loc == nil {
		loc = time.UTC
	}
	if clientDate == "" {
		local := loggedAt.In(loc)
		return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC), nil
	}

	parsed, err := time.ParseInLocation(layout, clientDate, time.UTC)
	if err != nil {
		return time.Time{}, httpx.ValidationError{
			Message: fmt.Sprintf("local_date must be YYYY-MM-DD, got %q", clientDate),
		}
	}

	utc := loggedAt.UTC()
	utcDay := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	if diff := parsed.Sub(utcDay); diff > window || diff < -window {
		return time.Time{}, httpx.ValidationError{
			Message: "local_date is too far from logged_at to be a real timezone",
		}
	}
	return parsed, nil
}
