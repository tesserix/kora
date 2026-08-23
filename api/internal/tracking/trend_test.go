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

func TestWeeklyRateRejectsReadingsAllAtOneInstantViaTheSpanGate(t *testing.T) {
	// All readings share one instant, so spanDays == 0. It is the SPAN GATE
	// (spanDays < minRateSpanDays) that rejects this input, not the den == 0
	// guard further down -- that guard is unreachable while the span gate
	// stands, since identical timestamps can never clear it.
	at := day(0)
	_, ok := WeeklyRate([]RatePoint{
		{At: at, Value: 80}, {At: at, Value: 80.1},
		{At: at, Value: 79.9}, {At: at, Value: 80.2},
	})
	require.False(t, ok, "zero time variance has no slope and must not divide by zero")
}

func entry(n int, src Source, weight float64, bodyFat *float64) WeightEntry {
	return WeightEntry{LoggedAt: day(n), WeightKg: weight, BodyComposition: BodyComposition{BodyFatPct: bodyFat, Source: src}}
}

func pct(v float64) *float64 { return &v }

// Weight is a kilogram whichever scale reported it, so all sources fit.
func TestPointsForWeightSpanAllSources(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, nil),
		entry(7, SourceManual, 79.5, nil),
		entry(14, SourceHealthKit, 79, nil),
		entry(21, SourceScaleScreenshot, 78.5, nil),
	}
	points, spans := PointsForMetric(entries, "weight_kg")
	require.Len(t, points, 4, "weight must not be split by instrument")
	require.True(t, spans)
}

// Vendors disagree about body fat by 20+ points, so only the trailing run fits.
func TestPointsForBodyFatUseTrailingInstrumentRunOnly(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, pct(30)),
		entry(7, SourceManual, 79.5, pct(29)),
		entry(14, SourceScaleScreenshot, 79, pct(24)),
		entry(21, SourceScaleScreenshot, 78.5, pct(23.5)),
	}
	points, spans := PointsForMetric(entries, "body_fat_pct")
	require.Len(t, points, 2, "only the trailing scale_screenshot run may be fitted")
	require.False(t, spans, "a single-instrument run never spans instruments")
	require.InDelta(t, 24, points[0].Value, 0.0001)
}

// A tape is a tape; source describes the WEIGH-IN, not the measurement.
func TestPointsForTapeMeasurementSpanAllSources(t *testing.T) {
	waist := func(v float64) *float64 { return &v }
	entries := []WeightEntry{
		{LoggedAt: day(0), WeightKg: 80, BodyComposition: BodyComposition{WaistCm: waist(90), Source: SourceManual}},
		{LoggedAt: day(7), WeightKg: 79.5, BodyComposition: BodyComposition{WaistCm: waist(89), Source: SourceManual}},
		{LoggedAt: day(14), WeightKg: 79, BodyComposition: BodyComposition{WaistCm: waist(88), Source: SourceScaleScreenshot}},
		{LoggedAt: day(21), WeightKg: 78.5, BodyComposition: BodyComposition{WaistCm: waist(87), Source: SourceScaleScreenshot}},
	}
	points, _ := PointsForMetric(entries, "waist_cm")
	require.Len(t, points, 4, "a tape series must not be split on the weigh-in's instrument")
}

func TestPointsForMetricSkipsEntriesMissingThatMetric(t *testing.T) {
	entries := []WeightEntry{
		entry(0, SourceManual, 80, pct(30)),
		entry(7, SourceManual, 79.5, nil),
		entry(14, SourceManual, 79, pct(29)),
	}
	points, _ := PointsForMetric(entries, "body_fat_pct")
	require.Len(t, points, 2, "an absent optional metric is not a zero reading")
}

func TestFitsAcrossInstruments(t *testing.T) {
	require.True(t, FitsAcrossInstruments("weight_kg"))
	require.True(t, FitsAcrossInstruments("waist_cm"))
	require.True(t, FitsAcrossInstruments("thigh_cm"))
	require.False(t, FitsAcrossInstruments("body_fat_pct"))
	require.False(t, FitsAcrossInstruments("muscle_mass_kg"))
	require.False(t, FitsAcrossInstruments("scale_bmr_kcal"))
}
