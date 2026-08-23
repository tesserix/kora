// Package tracking owns water and weight entries.
package tracking

import (
	"time"

	"github.com/google/uuid"
)

type WaterEntry struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID   uuid.UUID `json:"-"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the calendar day this entry belongs to, in the DEVICE's zone
	// at capture. Fixed at write time so a profile timezone change cannot move
	// it to another day. See kora#84 and internal/localday.
	LocalDate time.Time `gorm:"type:date;not null" json:"local_date"`
	VolumeML  int       `json:"volume_ml"`
	CreatedAt time.Time `json:"created_at"`
}

// Source records which instrument produced a body-composition reading.
//
// This is not decoration. The same-named metric is NOT comparable across
// instruments: Renpho reports Skeletal Muscle at 48.9% where Omron reports
// 25.7% for the same body, and DEXA body fat differs from consumer
// bioimpedance by several points on the same day. A chart that joins two
// sources without consulting this field shows a person losing half their
// muscle overnight. See kora#45 and migration 000039.
type Source string

const (
	SourceManual          Source = "manual"
	SourceScaleScreenshot Source = "scale_screenshot" // kora#314
	SourceInBody          Source = "inbody"
	SourceDEXA            Source = "dexa"
	SourceHealthKit       Source = "healthkit" // kora#30
)

// Sources is the allowlist, mirroring weight_entries_source_check in
// migration 000039. Changing one side alone makes the CHECK reject a write the
// Go layer accepted, so change both.
var Sources = []Source{
	SourceManual,
	SourceScaleScreenshot,
	SourceInBody,
	SourceDEXA,
	SourceHealthKit,
}

func (s Source) valid() bool {
	for _, known := range Sources {
		if s == known {
			return true
		}
	}
	return false
}

// BodyComposition is what a scale, InBody or DEXA report measured alongside
// weight (kora#45).
//
// Every metric is a POINTER because absent must not collapse into zero: a body
// fat of 0.0% is not "unknown", and the moment a chart plots the difference the
// two become a visible lie. Units are in the field and column names, following
// the existing weight_kg / body_fat_pct convention.
//
// Only MEASURED values live here. BMI, fat-free mass, fat mass in kg and
// metabolic age are derived or vendor-invented and are deliberately absent —
// migration 000039 lists each with its reason, and the client derives them in
// apps/mobile/src/lib/bodyComposition.ts.
type BodyComposition struct {
	// BodyFatPct has existed on the table since 000002_phase1_core but was
	// dormant — absent from this struct and from the client type — until #45.
	BodyFatPct         *float64 `json:"body_fat_pct,omitempty"`
	SubcutaneousFatPct *float64 `json:"subcutaneous_fat_pct,omitempty"`
	// VisceralFatRating is a vendor RATING, not a percentage — hence no _pct.
	// Renpho shows a bare `7`, Omron `7.5 level`, Tanita a 1-59 scale. Never
	// render it with a % sign.
	VisceralFatRating *float64 `json:"visceral_fat_rating,omitempty"`
	// SkeletalMusclePct is a SUBSET of MuscleMassKg's quantity, not the same
	// number in another unit. Renpho reports both; conflating them is wrong.
	SkeletalMusclePct *float64 `json:"skeletal_muscle_pct,omitempty"`
	MuscleMassKg      *float64 `json:"muscle_mass_kg,omitempty"`
	BodyWaterPct      *float64 `json:"body_water_pct,omitempty"`
	ProteinPct        *float64 `json:"protein_pct,omitempty"`
	// BoneMassKg is mass in kg as a scale reports it. A DEXA report's bone
	// DENSITY (BMD, T-score) is a different quantity and does not belong here.
	BoneMassKg *float64 `json:"bone_mass_kg,omitempty"`
	// ScaleBMRKcal is recorded for COMPARISON ONLY and must never feed a
	// calorie target. Kora derives BMR itself via Mifflin-St Jeor in
	// internal/onboarding/calc.go, and that is what drives the daily target and
	// its floor. Renpho and Omron disagree by ~200 kcal/day on the same body,
	// so a scale-driven target would jump when the user changes scales.
	ScaleBMRKcal *float64 `json:"scale_bmr_kcal,omitempty"`
	// Tape measurements (kora#45). Stored in centimetres; the client converts
	// for display. Unlike the metrics above they come from a tape, not a
	// scale, so they are typically filled in one or two at a time — which is
	// exactly why each is a pointer with omitempty, like everything else here.
	//
	// They are NOT part of the screenshot reader's schema: a scale screenshot
	// can never contain a tape measurement, so ai.BodyCompositionReading in
	// internal/ai/types.go must not gain these fields.
	NeckCm  *float64 `json:"neck_cm,omitempty"`
	ChestCm *float64 `json:"chest_cm,omitempty"`
	WaistCm *float64 `json:"waist_cm,omitempty"`
	HipCm   *float64 `json:"hip_cm,omitempty"`
	// ArmCm and ThighCm are singular by design: whichever limb the user
	// measures consistently. A left/right pair would double the fields for a
	// difference a consumer tape does not reliably resolve.
	ArmCm   *float64 `json:"arm_cm,omitempty"`
	ThighCm *float64 `json:"thigh_cm,omitempty"`
	// Source defaults to SourceManual when unset — see the Source doc comment
	// for why it is load-bearing rather than metadata.
	Source Source `gorm:"not null;default:manual" json:"source"`
}

type WeightEntry struct {
	ID       uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	UserID   uuid.UUID `json:"-"`
	WeightKg float64   `json:"weight_kg"`
	LoggedAt time.Time `json:"logged_at"`
	// LocalDate is the calendar day this entry belongs to, in the DEVICE's zone
	// at capture. Fixed at write time so a profile timezone change cannot move
	// it to another day. See kora#84 and internal/localday.
	LocalDate time.Time `gorm:"type:date;not null" json:"local_date"`
	// Embedded rather than nested so the columns stay flat on weight_entries
	// and the JSON stays flat for the client (kora#45).
	BodyComposition `gorm:"embedded"`
	// HKUUID is the HealthKit sample's own identifier, present only on rows
	// synced from Apple Health (kora#30). It is what makes a re-sync a no-op
	// rather than a duplicate. NULL for manual, screenshot and InBody rows --
	// they have no HealthKit sample behind them.
	HKUUID    *uuid.UUID `gorm:"column:hk_uuid" json:"hk_uuid,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}
