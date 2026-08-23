package tracking

import "time"

// minRateReadings and minRateSpanDays are the gate from the design doc.
// BOTH are required: a count alone lets four weigh-ins in one morning
// produce a "weekly rate", and a span alone lets two readings a month
// apart do it. They are measured on the points actually fitted, never on
// the range the caller asked for.
const (
	minRateReadings = 4
	minRateSpanDays = 14
)

// RatePoint is one reading being fitted.
type RatePoint struct {
	At    time.Time
	Value float64
}

// RateBasis is the evidence behind a rate — shown to the user, so it must
// describe the points FITTED, not the window requested.
type RateBasis struct {
	Readings int
	Days     int
}

// RateResult is a fitted rate in units-per-week.
type RateResult struct {
	PerWeek float64
	Basis   RateBasis
}

// WeeklyRate fits ordinary least squares over (time, value) and returns the
// slope per week. ok is false when the gate rejects the input.
//
// OLS rather than last-minus-first because last-minus-first is determined
// entirely by two readings: one bloated morning at either end swings it
// wildly, and can flip its sign.
func WeeklyRate(points []RatePoint) (RateResult, bool) {
	if len(points) < minRateReadings {
		return RateResult{}, false
	}
	first, last := points[0].At, points[len(points)-1].At
	spanDays := int(last.Sub(first).Hours() / 24)
	if spanDays < minRateSpanDays {
		return RateResult{}, false
	}

	// x in days since the first reading; keeps the numbers small and makes
	// the slope trivially convertible to per-week.
	var sumX, sumY float64
	for _, p := range points {
		sumX += p.At.Sub(first).Hours() / 24
		sumY += p.Value
	}
	n := float64(len(points))
	meanX, meanY := sumX/n, sumY/n

	var num, den float64
	for _, p := range points {
		dx := p.At.Sub(first).Hours()/24 - meanX
		num += dx * (p.Value - meanY)
		den += dx * dx
	}
	if den == 0 {
		// Every reading at the same instant: no slope exists. Guarded
		// explicitly rather than relying on the span gate, because equal
		// timestamps can still clear a span if the caller passes odd data.
		return RateResult{}, false
	}

	return RateResult{
		PerWeek: (num / den) * 7,
		Basis:   RateBasis{Readings: len(points), Days: spanDays},
	}, true
}
