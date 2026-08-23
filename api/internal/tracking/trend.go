package tracking

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/guardrails"
)

// SignalsSource supplies the risk signals the Protective policy needs.
// Declared here and satisfied by coach so that tracking never imports it —
// the risk computation must have exactly one definition (design doc,
// decision 5).
//
// loc is taken per call, not pinned at construction: the risk computation
// behind it excludes "today" by LOCAL day, so a server-wide fixed zone would
// count the wrong days for any user outside it and feed a wrong
// eating-disorder classification. Every other caller of BuildContext already
// takes the location per request (see coach/handler.go).
type SignalsSource interface {
	SignalsFor(ctx context.Context, userID uuid.UUID, loc *time.Location) (guardrails.Signals, error)
}

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
// slope per week. ok is false when the gate rejects the input. Requires
// points to be ordered oldest first; it does not sort or validate this.
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
		// Every reading at the same instant: no slope exists.
		//
		// Currently UNREACHABLE -- den == 0 requires every timestamp to be
		// identical, which forces spanDays == 0, which the span gate above
		// already rejects. Kept deliberately: it is the only thing standing
		// between a relaxed gate and a NaN reaching the user, and it costs
		// one comparison. Do not write a test claiming to cover it; nothing
		// can reach it while the gate stands.
		return RateResult{}, false
	}

	return RateResult{
		PerWeek: (num / den) * 7,
		Basis:   RateBasis{Readings: len(points), Days: spanDays},
	}, true
}

// tapeMetrics are the measurements taken with a tape rather than by the
// instrument named in Source. Kept as a set rather than a "_cm" suffix
// check so that adding a future centimetre column is a deliberate decision.
var tapeMetrics = map[string]bool{
	"neck_cm": true, "chest_cm": true, "waist_cm": true,
	"hip_cm": true, "arm_cm": true, "thigh_cm": true,
}

// FitsAcrossInstruments reports whether a metric may be fitted across a
// change of instrument.
//
// This deliberately departs from bodyCompositionSeries.ts, which refuses
// EVERY cross-instrument figure. Two reasons, both in the design doc:
// vendors disagree about body fat by 20+ points but about weight by a few
// hundred grams, well inside the noise a weekly rate already tolerates; and
// Source describes the WEIGH-IN, so splitting a tape series on it would
// split on something unrelated to how the tape was read.
func FitsAcrossInstruments(metric string) bool {
	return metric == "weight_kg" || tapeMetrics[metric]
}

// PointsForMetric selects the readings to fit. It requires entries to be
// ordered oldest first, which Repository.WeightSeries guarantees via
// Order("logged_at ASC"); WeeklyRate assumes the same ordering. The second
// return is whether those points span more than one instrument, which the
// caller surfaces as a note beside the figure.
func PointsForMetric(entries []WeightEntry, metric string) ([]RatePoint, bool) {
	all := make([]RatePoint, 0, len(entries))
	sources := make([]Source, 0, len(entries))
	for _, e := range entries {
		v, ok := metricValue(e, metric)
		if !ok {
			continue // absent is not zero
		}
		all = append(all, RatePoint{At: e.LoggedAt, Value: v})
		sources = append(sources, e.Source)
	}
	if len(all) == 0 {
		return nil, false
	}

	if FitsAcrossInstruments(metric) {
		return all, spansMoreThanOne(sources)
	}

	// Trailing same-instrument run only.
	start := len(all) - 1
	for start > 0 && sources[start-1] == sources[start] {
		start--
	}
	return all[start:], false
}

func spansMoreThanOne(sources []Source) bool {
	for i := 1; i < len(sources); i++ {
		if sources[i] != sources[0] {
			return true
		}
	}
	return false
}

// compositionAccessors maps every metric key stored on BodyComposition to the
// field it reads.
//
// A table rather than a switch, deliberately (kora#399). With a switch, the
// endpoint's allow-list had to be a SECOND hand-maintained list, and a metric
// added to one but not the other was undetectable: the obvious test walks the
// allow-list, and a reverse-direction test would have to walk a hand-written
// expectation map that shares the same blind spot. Deriving knownMetric from
// this table makes the two agree by construction instead of by vigilance.
var compositionAccessors = map[string]func(BodyComposition) *float64{
	"body_fat_pct":         func(c BodyComposition) *float64 { return c.BodyFatPct },
	"subcutaneous_fat_pct": func(c BodyComposition) *float64 { return c.SubcutaneousFatPct },
	"visceral_fat_rating":  func(c BodyComposition) *float64 { return c.VisceralFatRating },
	"skeletal_muscle_pct":  func(c BodyComposition) *float64 { return c.SkeletalMusclePct },
	"muscle_mass_kg":       func(c BodyComposition) *float64 { return c.MuscleMassKg },
	"body_water_pct":       func(c BodyComposition) *float64 { return c.BodyWaterPct },
	"protein_pct":          func(c BodyComposition) *float64 { return c.ProteinPct },
	"bone_mass_kg":         func(c BodyComposition) *float64 { return c.BoneMassKg },
	"scale_bmr_kcal":       func(c BodyComposition) *float64 { return c.ScaleBMRKcal },
	"neck_cm":              func(c BodyComposition) *float64 { return c.NeckCm },
	"chest_cm":             func(c BodyComposition) *float64 { return c.ChestCm },
	"waist_cm":             func(c BodyComposition) *float64 { return c.WaistCm },
	"hip_cm":               func(c BodyComposition) *float64 { return c.HipCm },
	"arm_cm":               func(c BodyComposition) *float64 { return c.ArmCm },
	"thigh_cm":             func(c BodyComposition) *float64 { return c.ThighCm },
}

// weightMetricKey is the one metric that is not on BodyComposition -- it is
// the weigh-in itself, a plain non-pointer field, and therefore always present.
const weightMetricKey = "weight_kg"

// metricValue reads one metric off an entry. The bool is false when the entry
// did not record it -- absent is NOT zero, which is the rule the whole
// composition schema is built on. An unknown metric name is also false, never
// a fabricated reading of zero fitted through the gap.
func metricValue(e WeightEntry, metric string) (float64, bool) {
	if metric == weightMetricKey {
		return e.WeightKg, true
	}
	accessor, ok := compositionAccessors[metric]
	if !ok {
		return 0, false
	}
	p := accessor(e.BodyComposition)
	if p == nil {
		return 0, false
	}
	return *p, true
}

// knownMetric reports whether a rate may be fitted over this metric. Derived
// from compositionAccessors so the allow-list cannot drift from what
// metricValue can actually read (kora#399).
func knownMetric(metric string) bool {
	if metric == weightMetricKey {
		return true
	}
	_, ok := compositionAccessors[metric]
	return ok
}
