package fasting

import "time"

// EffectiveEnd is when a fast actually ended, whatever the row says.
//
// Three of the four bounds are computed rather than stored (kora#407):
//
//   - the explicit end, when the user tapped it
//   - the first food log after the fast started -- eating IS the end of a
//     fast, and resolving it here means no food-log write path has to be
//     hooked. foodlog.Repository.Create has three call sites plus
//     CreateIdempotent; hooking all of them and missing one would leave
//     fasts silently open.
//   - started_at + CapHours, so an abandoned fast plateaus instead of
//     accruing into a false risk flag on stale state
//   - now, because a fast cannot extend into the future
//
// The earliest wins.
func EffectiveEnd(i Interval, firstLogAfterStart *time.Time, now time.Time) time.Time {
	end := i.StartedAt.Add(CapHours * time.Hour)
	if end.After(now) {
		end = now
	}
	if i.EndedAt != nil && i.EndedAt.Before(end) {
		end = *i.EndedAt
	}
	// A log at or before the start cannot have ended this fast.
	if firstLogAfterStart != nil && firstLogAfterStart.After(i.StartedAt) && firstLogAfterStart.Before(end) {
		end = *firstLogAfterStart
	}
	return end
}

// Hours is EffectiveEnd minus the start, floored at zero.
func Hours(i Interval, firstLogAfterStart *time.Time, now time.Time) float64 {
	d := EffectiveEnd(i, firstLogAfterStart, now).Sub(i.StartedAt).Hours()
	if d < 0 {
		return 0
	}
	return d
}
