package bodyread

import (
	"fmt"
	"time"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/tracking"
)

// DroppedField records one field validateReading discarded from a provider's
// reading, and why. The service surfaces the full list in Result.Dropped and
// the handler puts it on the wire (rule #11) — a client that gets back a
// partial reading needs to be able to tell a user "the scale's BMR figure
// looked wrong so it was left out" rather than silently losing the field
// with no explanation.
type DroppedField struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

const (
	// pctMin/pctMax bound every field that is genuinely a percentage of body
	// mass: body_fat_pct, subcutaneous_fat_pct, skeletal_muscle_pct,
	// body_water_pct, protein_pct. 0-100 is the only physically sane range
	// for a percentage — anything outside it is a misread (e.g. an extra
	// digit, a decimal point in the wrong place), never a real measurement.
	pctMin = 0.0
	pctMax = 100.0

	// visceralRatingMax bounds visceral_fat_rating. This field is
	// deliberately EXCLUDED from the pctMin/pctMax check above: it is a
	// vendor RATING on an arbitrary per-manufacturer scale, not a
	// percentage (rule #8 — validating it as a percentage is exactly the
	// percent-vs-rating confusion that rule exists to prevent). Tanita's
	// documented scale tops out at 59; 60 is one above that documented
	// maximum, chosen as a generous ceiling rather than a clinical
	// judgment, so a legitimate reading at the top of a vendor's scale is
	// never dropped. visceral_fat_rating has no lower bound beyond
	// non-negative — a rating cannot be negative.
	visceralRatingMin = 0.0
	visceralRatingMax = 60.0

	// weightMinKg/weightMaxKg bound weight_kg to a sane human range.
	// 20kg is a floor generous enough to cover a genuinely low adult
	// outlier while still catching a decimal-place misread — e.g. the model
	// reading "18.2" off a screenshot as "1.82" and this floor rejecting it
	// as implausible for an adult. 300kg is a generous outlier ceiling, not
	// a clinical judgment: it exists only to catch a garbled read (an extra
	// digit), not to flag genuine outliers within human range.
	weightMinKg = 20.0
	weightMaxKg = 300.0

	// readingDateLayout is the exact calendar-date format the vision model
	// is instructed to return reading_date in (see
	// ai.BodyCompositionReading's doc comment) — never a timestamp, since a
	// reading may be uploaded days after it was taken.
	readingDateLayout = "2006-01-02"
)

// detectableInstruments is the allowlist for BodyCompositionReading.
// Instrument — the subset of tracking.Sources a vision model could ever
// legitimately DETECT from an image. Deliberately narrower than
// tracking.Sources: "manual" and "healthkit" describe HOW a reading
// entered Kora, not what is visible in a screenshot, so a model returning
// either of those (or anything else) is malformed output, not a real
// detection, and must be dropped exactly like any other implausible
// value — never let it reach the client, since the write path's CHECK
// constraint on weight_entries would still accept "manual"/"healthkit"
// there and silently misattribute provenance for a reading that actually
// came from a photo.
var detectableInstruments = map[string]bool{
	string(tracking.SourceScaleScreenshot): true,
	string(tracking.SourceInBody):          true,
	string(tracking.SourceDEXA):            true,
}

// validateReading returns a NEW reading with every implausible field set to
// nil, plus the list of what was dropped and why. It never mutates r: each
// field below is either carried over unchanged (the same pointer — the
// pointee is never written to) or replaced with nil, so the caller's copy of
// r is untouched either way.
func validateReading(r ai.BodyCompositionReading, now time.Time) (ai.BodyCompositionReading, []DroppedField) {
	// Initialized to a non-nil empty slice, not left as a nil zero value:
	// json.Marshal renders a nil slice as `null` and a non-nil empty slice
	// as `[]`. Result.Dropped reaching the wire as `null` when nothing was
	// dropped would force every client to handle two different "empty"
	// shapes for the same field.
	dropped := []DroppedField{}

	out := ai.BodyCompositionReading{
		WeightKg:           validateRange("weight_kg", r.WeightKg, weightMinKg, weightMaxKg, "kg", &dropped),
		BodyFatPct:         validatePct("body_fat_pct", r.BodyFatPct, &dropped),
		SubcutaneousFatPct: validatePct("subcutaneous_fat_pct", r.SubcutaneousFatPct, &dropped),
		VisceralFatRating:  validateRange("visceral_fat_rating", r.VisceralFatRating, visceralRatingMin, visceralRatingMax, "", &dropped),
		SkeletalMusclePct:  validatePct("skeletal_muscle_pct", r.SkeletalMusclePct, &dropped),
		MuscleMassKg:       validatePositive("muscle_mass_kg", r.MuscleMassKg, &dropped),
		BodyWaterPct:       validatePct("body_water_pct", r.BodyWaterPct, &dropped),
		ProteinPct:         validatePct("protein_pct", r.ProteinPct, &dropped),
		BoneMassKg:         validatePositive("bone_mass_kg", r.BoneMassKg, &dropped),
		ScaleBMRKcal:       validatePositive("scale_bmr_kcal", r.ScaleBMRKcal, &dropped),
		// ReadingDateText carries straight through, unvalidated — it is raw
		// transcribed text, not a measurement, so there is no range/format
		// to enforce on it; it exists so a client showing PR B's editable
		// date row can explain WHY a date resolved the way it did (or
		// didn't). ReadingDate is the field callers should treat as
		// authoritative for storage — it already went through
		// resolveReadingDateText's deterministic rule (service.go) before
		// reaching here, and gets its own future-date/parse guard below,
		// same as before this fix.
		ReadingDateText: r.ReadingDateText,
		ReadingDate:     validateReadingDate(r.ReadingDate, now, &dropped),
		Instrument:      validateInstrument(r.Instrument, &dropped),
	}

	return out, dropped
}

// validatePct enforces the [0,100] percent bound shared by every field that
// is genuinely a percentage of body mass. nil in, nil out — an absent field
// is not a drop, it is simply nothing the model reported.
func validatePct(field string, v *float64, dropped *[]DroppedField) *float64 {
	return validateRange(field, v, pctMin, pctMax, "%", dropped)
}

// validatePositive enforces "greater than zero" for fields where zero or
// negative is not a measurement at all (a mass or a BMR cannot be zero) —
// distinct from validateRange because these fields have no meaningful upper
// bound to speak of, only a floor.
func validatePositive(field string, v *float64, dropped *[]DroppedField) *float64 {
	if v == nil {
		return nil
	}
	if *v <= 0 {
		*dropped = append(*dropped, DroppedField{
			Field:  field,
			Reason: fmt.Sprintf("%s %.4g is not positive", field, *v),
		})
		return nil
	}
	val := *v
	return &val
}

// validateRange enforces an inclusive [min,max] bound, used by both the
// percent fields (unit "%") and the two fields with their own bespoke
// ranges (weight_kg in kg, visceral_fat_rating unitless). Boundary values
// (min and max themselves) are VALID, not dropped — an exact 0% or 100%
// reading is a plausible measurement, not an error.
func validateRange(field string, v *float64, min, max float64, unit string, dropped *[]DroppedField) *float64 {
	if v == nil {
		return nil
	}
	if *v < min || *v > max {
		*dropped = append(*dropped, DroppedField{
			Field:  field,
			Reason: fmt.Sprintf("%s %.4g%s outside %g-%g range", field, *v, unit, min, max),
		})
		return nil
	}
	val := *v
	return &val
}

// validateReadingDate parses reading_date as YYYY-MM-DD and drops it when it
// fails to parse OR names a calendar date after "now"'s calendar date. Both
// sides are truncated to their calendar date (year/month/day, midnight UTC)
// before comparing — never compared as instants — so a same-day reading
// captured in the evening is never dropped as "in the future" just because
// `now` happens to carry an earlier time-of-day within that same day.
func validateReadingDate(s *string, now time.Time, dropped *[]DroppedField) *string {
	if s == nil {
		return nil
	}
	parsed, err := time.Parse(readingDateLayout, *s)
	if err != nil {
		*dropped = append(*dropped, DroppedField{
			Field:  "reading_date",
			Reason: fmt.Sprintf("reading_date %q is not a valid YYYY-MM-DD date", *s),
		})
		return nil
	}

	// One day of grace on the future side, not zero: `now` is server-local
	// (UTC in production), and the whole point of reading_date is the
	// CLIENT's own calendar day — a screenshot genuinely dated "today" in
	// IST (Kora's primary market, UTC+5:30) reads as "tomorrow" in UTC for
	// the entire 18:30-24:00 IST window, which would silently drop a
	// perfectly legible, perfectly true date on every single evening
	// upload. internal/localday.Resolve reconciles this exact class of
	// client-day-vs-server-day mismatch by accepting one day either side —
	// this mirrors that same tolerance rather than inventing a new one.
	// Anything beyond one day ahead is no longer explainable by timezone
	// skew and is genuinely implausible (a screenshot cannot show a date
	// that has not happened yet).
	today := truncateToDate(now)
	maxAllowedDate := today.AddDate(0, 0, 1)
	if truncateToDate(parsed).After(maxAllowedDate) {
		*dropped = append(*dropped, DroppedField{
			Field:  "reading_date",
			Reason: fmt.Sprintf("reading_date %s is too far in the future (today is %s)", *s, today.Format(readingDateLayout)),
		})
		return nil
	}

	val := *s
	return &val
}

// validateInstrument enforces the detectableInstruments allowlist (rule #3
// on kora#314: the write path's CHECK constraint on weight_entries.source
// would reject an unknown string outright and the user would lose an
// otherwise-good, confirmed reading — this must never let that happen by
// dropping anything outside the known three to nil BEFORE it reaches the
// client). nil in, nil out — the model declining to detect an instrument is
// not a drop, it is the conservative behavior kora#314 asks for.
func validateInstrument(v *string, dropped *[]DroppedField) *string {
	if v == nil {
		return nil
	}
	if !detectableInstruments[*v] {
		*dropped = append(*dropped, DroppedField{
			Field:  "instrument",
			Reason: fmt.Sprintf("instrument %q is not one of scale_screenshot, inbody, dexa", *v),
		})
		return nil
	}
	val := *v
	return &val
}

// truncateToDate strips a time.Time down to its calendar date at midnight
// UTC, so two times on the same calendar date compare equal regardless of
// their time-of-day or original location.
func truncateToDate(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
