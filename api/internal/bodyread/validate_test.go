package bodyread

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
)

func ptr(f float64) *float64 { return &f }
func sptr(s string) *string  { return &s }

// fixedNow is a stable reference instant for date-comparison tests.
var fixedNow = time.Date(2026, 8, 22, 18, 30, 0, 0, time.UTC)

func TestValidateReading(t *testing.T) {
	tests := []struct {
		name        string
		in          ai.BodyCompositionReading
		wantDropped []string // field names expected in Dropped
		check       func(t *testing.T, out ai.BodyCompositionReading)
	}{
		{
			name:        "body fat percent out of range is dropped",
			in:          ai.BodyCompositionReading{BodyFatPct: ptr(182)},
			wantDropped: []string{"body_fat_pct"},
			check:       func(t *testing.T, out ai.BodyCompositionReading) { assert.Nil(t, out.BodyFatPct) },
		},
		{
			name:        "body fat percent negative is dropped",
			in:          ai.BodyCompositionReading{BodyFatPct: ptr(-1)},
			wantDropped: []string{"body_fat_pct"},
			check:       func(t *testing.T, out ai.BodyCompositionReading) { assert.Nil(t, out.BodyFatPct) },
		},
		{
			name:        "body fat percent boundary 0 is kept",
			in:          ai.BodyCompositionReading{BodyFatPct: ptr(0)},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.BodyFatPct)
				assert.Equal(t, 0.0, *out.BodyFatPct)
			},
		},
		{
			name:        "body fat percent boundary 100 is kept",
			in:          ai.BodyCompositionReading{BodyFatPct: ptr(100)},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.BodyFatPct)
				assert.Equal(t, 100.0, *out.BodyFatPct)
			},
		},
		{
			name:        "subcutaneous fat percent out of range is dropped",
			in:          ai.BodyCompositionReading{SubcutaneousFatPct: ptr(101)},
			wantDropped: []string{"subcutaneous_fat_pct"},
		},
		{
			name:        "skeletal muscle percent out of range is dropped",
			in:          ai.BodyCompositionReading{SkeletalMusclePct: ptr(-5)},
			wantDropped: []string{"skeletal_muscle_pct"},
		},
		{
			name:        "body water percent out of range is dropped",
			in:          ai.BodyCompositionReading{BodyWaterPct: ptr(150)},
			wantDropped: []string{"body_water_pct"},
		},
		{
			name:        "protein percent out of range is dropped",
			in:          ai.BodyCompositionReading{ProteinPct: ptr(-10)},
			wantDropped: []string{"protein_pct"},
		},
		{
			// The trap test for rule #8: a rating-typical value (way above
			// 100 would be wrong for a percent, but 45 is well within
			// percent range too, so this alone wouldn't catch the bug —
			// the NEXT case is the one that actually would).
			name:        "visceral fat rating at 45 is kept (not treated as a percent)",
			in:          ai.BodyCompositionReading{VisceralFatRating: ptr(45)},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.VisceralFatRating)
				assert.Equal(t, 45.0, *out.VisceralFatRating)
			},
		},
		{
			name:        "visceral fat rating negative is dropped",
			in:          ai.BodyCompositionReading{VisceralFatRating: ptr(-1)},
			wantDropped: []string{"visceral_fat_rating"},
		},
		{
			name:        "visceral fat rating above ceiling is dropped",
			in:          ai.BodyCompositionReading{VisceralFatRating: ptr(61)},
			wantDropped: []string{"visceral_fat_rating"},
		},
		{
			name:        "visceral fat rating at ceiling boundary 60 is kept",
			in:          ai.BodyCompositionReading{VisceralFatRating: ptr(60)},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.VisceralFatRating)
				assert.Equal(t, 60.0, *out.VisceralFatRating)
			},
		},
		{
			name:        "weight zero is dropped (non-positive)",
			in:          ai.BodyCompositionReading{WeightKg: ptr(0)},
			wantDropped: []string{"weight_kg"},
		},
		{
			name:        "weight negative is dropped",
			in:          ai.BodyCompositionReading{WeightKg: ptr(-5)},
			wantDropped: []string{"weight_kg"},
		},
		{
			name:        "weight below sane floor is dropped",
			in:          ai.BodyCompositionReading{WeightKg: ptr(18.2)},
			wantDropped: []string{"weight_kg"},
		},
		{
			name:        "weight above sane ceiling is dropped",
			in:          ai.BodyCompositionReading{WeightKg: ptr(305)},
			wantDropped: []string{"weight_kg"},
		},
		{
			name:        "plausible weight is kept",
			in:          ai.BodyCompositionReading{WeightKg: ptr(72.4)},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.WeightKg)
				assert.Equal(t, 72.4, *out.WeightKg)
			},
		},
		{
			name:        "muscle mass zero is dropped",
			in:          ai.BodyCompositionReading{MuscleMassKg: ptr(0)},
			wantDropped: []string{"muscle_mass_kg"},
		},
		{
			name:        "muscle mass negative is dropped",
			in:          ai.BodyCompositionReading{MuscleMassKg: ptr(-1)},
			wantDropped: []string{"muscle_mass_kg"},
		},
		{
			name:        "muscle mass positive is kept",
			in:          ai.BodyCompositionReading{MuscleMassKg: ptr(30)},
			wantDropped: nil,
		},
		{
			name:        "bone mass zero is dropped",
			in:          ai.BodyCompositionReading{BoneMassKg: ptr(0)},
			wantDropped: []string{"bone_mass_kg"},
		},
		{
			name:        "bone mass positive is kept",
			in:          ai.BodyCompositionReading{BoneMassKg: ptr(3)},
			wantDropped: nil,
		},
		{
			name:        "scale bmr zero is dropped",
			in:          ai.BodyCompositionReading{ScaleBMRKcal: ptr(0)},
			wantDropped: []string{"scale_bmr_kcal"},
		},
		{
			name:        "scale bmr negative is dropped",
			in:          ai.BodyCompositionReading{ScaleBMRKcal: ptr(-100)},
			wantDropped: []string{"scale_bmr_kcal"},
		},
		{
			name:        "scale bmr positive is kept",
			in:          ai.BodyCompositionReading{ScaleBMRKcal: ptr(1600)},
			wantDropped: nil,
		},
		{
			name:        "unparseable reading date is dropped",
			in:          ai.BodyCompositionReading{ReadingDate: sptr("not-a-date")},
			wantDropped: []string{"reading_date"},
		},
		{
			name:        "future reading date is dropped",
			in:          ai.BodyCompositionReading{ReadingDate: sptr("2026-08-23")},
			wantDropped: []string{"reading_date"},
		},
		{
			name:        "same-day reading date is kept even though now carries an evening time",
			in:          ai.BodyCompositionReading{ReadingDate: sptr("2026-08-22")},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				require.NotNil(t, out.ReadingDate)
				assert.Equal(t, "2026-08-22", *out.ReadingDate)
			},
		},
		{
			name:        "past reading date is kept",
			in:          ai.BodyCompositionReading{ReadingDate: sptr("2026-01-01")},
			wantDropped: nil,
		},
		{
			name:        "absent fields stay nil and are not reported as dropped",
			in:          ai.BodyCompositionReading{},
			wantDropped: nil,
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				assert.Nil(t, out.WeightKg)
				assert.Nil(t, out.ReadingDate)
			},
		},
		{
			name: "every field implausible yields a fully empty reading",
			in: ai.BodyCompositionReading{
				WeightKg:           ptr(-1),
				BodyFatPct:         ptr(999),
				SubcutaneousFatPct: ptr(999),
				VisceralFatRating:  ptr(999),
				SkeletalMusclePct:  ptr(999),
				MuscleMassKg:       ptr(-1),
				BodyWaterPct:       ptr(999),
				ProteinPct:         ptr(999),
				BoneMassKg:         ptr(-1),
				ScaleBMRKcal:       ptr(-1),
				ReadingDate:        sptr("garbage"),
			},
			wantDropped: []string{
				"weight_kg", "body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
				"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct", "protein_pct",
				"bone_mass_kg", "scale_bmr_kcal", "reading_date",
			},
			check: func(t *testing.T, out ai.BodyCompositionReading) {
				assert.True(t, isEmpty(out), "expected every field nil")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, dropped := validateReading(tt.in, fixedNow)

			var gotFields []string
			for _, d := range dropped {
				gotFields = append(gotFields, d.Field)
				assert.NotEmpty(t, d.Reason, "dropped field %s must carry a human-readable reason", d.Field)
			}
			assert.ElementsMatch(t, tt.wantDropped, gotFields)

			if tt.check != nil {
				tt.check(t, out)
			}
		})
	}
}

// TestValidateReading_DoesNotMutateInput guards the immutable-style
// requirement: validateReading must never write through the input's
// pointers, only decide whether to carry them into the output or drop them.
func TestValidateReading_DoesNotMutateInput(t *testing.T) {
	weight := 72.4
	in := ai.BodyCompositionReading{WeightKg: &weight}

	_, _ = validateReading(in, fixedNow)

	assert.Equal(t, 72.4, weight, "validateReading must not write through the input reading's pointers")
}
