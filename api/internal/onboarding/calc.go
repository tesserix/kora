// Package onboarding computes energy and macro targets from user metrics.
package onboarding

import "fmt"

type Input struct {
	Sex           string  `json:"sex"`
	BirthYear     int     `json:"birth_year"`
	HeightCm      float64 `json:"height_cm"`
	WeightKg      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
	Timezone      string  `json:"timezone"`

	// GoalWeightKg and PaceKgPerWeek are optional and ignored when Goal is
	// "maintenance" — the client never shows those controls for that goal,
	// so requiring them here would reject a payload the UI cannot produce.
	GoalWeightKg  float64 `json:"goal_weight_kg"`
	PaceKgPerWeek float64 `json:"pace_kg_per_week"`

	// Overrides replace the computed calorie and protein targets. nil means
	// "use the computed value"; bounds are enforced in Calculate.
	KcalOverride     *float64 `json:"target_kcal_override"`
	ProteinOverrideG *float64 `json:"target_protein_override_g"`
}

type Targets struct {
	Bmr      float64 `json:"bmr"`
	Tdee     float64 `json:"tdee"`
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
	// ProteinGPerKg and ProteinRefKg are the working behind ProteinG:
	// grams per kilo of the reference weight (goal weight for fat loss
	// when one is set, current weight otherwise).
	ProteinGPerKg float64 `json:"protein_g_per_kg"`
	ProteinRefKg  float64 `json:"protein_ref_kg"`
	// Floored reports that the resting-burn clamp bound — the requested
	// pace asked for a target below BMR and did not get it. Callers
	// surface this to the user rather than silently showing a number
	// that stopped obeying them.
	Floored bool `json:"floored"`
	// KcalOverridden and ProteinOverridden report that the user's own
	// number replaced the computed one.
	KcalOverridden    bool `json:"kcal_overridden"`
	ProteinOverridden bool `json:"protein_overridden"`
}

// Override error codes. The strings are a contract with the HTTP handler and
// the mobile Plan page (apps/mobile/src/lib/plan.ts OverrideCode).
const (
	CodeKcalBelowRestingBurn = "kcal_below_resting_burn"
	CodeKcalAboveCeiling     = "kcal_above_ceiling"
	CodeProteinBelowMin      = "protein_below_min"
	CodeProteinAboveMax      = "protein_above_max"
	CodeProteinExceedsShare  = "protein_exceeds_share"
)

// OverrideError reports an out-of-bounds calorie or protein override.
type OverrideError struct{ Code string }

func (e *OverrideError) Error() string { return "onboarding: invalid override: " + e.Code }

var activityFactors = map[string]float64{
	"sedentary":   1.2,
	"light":       1.375,
	"moderate":    1.55,
	"active":      1.725,
	"very_active": 1.9,
}

var validGoals = map[string]bool{
	"fat_loss":    true,
	"maintenance": true,
	"muscle_gain": true,
}

// Mifflin-St Jeor BMR coefficients and macro-split constants.
const (
	bmrWeightCoef    = 10.0
	bmrHeightCoef    = 6.25
	bmrAgeCoef       = 5.0
	bmrMaleOffset    = 5.0
	bmrFemaleOffset  = -161.0
	maxAgeYears      = 120
	fatCaloriePct    = 0.25
	kcalPerGramFat   = 9.0
	kcalPerGramMacro = 4.0 // protein and carbs

	// Plausibility bounds mirroring the client's own ruler and validation
	// limits (apps/mobile/src/lib/validateOnboarding.ts). The client copy
	// exists for message quality, not trust — these bounds are what actually
	// stop a physically incoherent measurement from reaching the calorie and
	// macro math below.
	minWeightKg = 20.0
	maxWeightKg = 500.0
	minHeightCm = 50.0
	maxHeightCm = 260.0

	// KcalPerKg is the energy density of body mass used to turn a weekly
	// rate of change into a daily calorie adjustment.
	KcalPerKg = 7700.0

	daysPerWeek = 7.0

	// maxPaceFractionOfBodyweight caps the weekly rate at 1% of bodyweight.
	// This is the primary safety limit; the BMR floor below is the backstop
	// for anything that slips past it.
	maxPaceFractionOfBodyweight = 0.01

	// Override bounds: calories between resting burn and twice TDEE; protein
	// between 0.8 and 2.5 g per kg of current weight and at most 75% of the
	// effective calories.
	maxKcalOverrideTdeeMultiple = 2.0
	minProteinOverrideGPerKg    = 0.8
	maxProteinOverrideGPerKg    = 2.5
	maxProteinOverrideKcalShare = 0.75
	// overrideEpsilon keeps a bound exactly on its edge (0.8 x 73 is
	// 58.400000000000006 in float) from rejecting the value that names it.
	overrideEpsilon = 1e-9
)

// proteinFactors is g/kg of the reference weight by goal then activity level.
// Higher in a deficit to protect muscle; inside the 1.2-2.2 g/kg range
// current guidance gives.
var proteinFactors = map[string]map[string]float64{
	"fat_loss":    {"sedentary": 1.6, "light": 1.6, "moderate": 1.8, "active": 1.8, "very_active": 1.8},
	"maintenance": {"sedentary": 1.2, "light": 1.4, "moderate": 1.6, "active": 1.6, "very_active": 1.6},
	"muscle_gain": {"sedentary": 1.8, "light": 1.8, "moderate": 2.0, "active": 2.0, "very_active": 2.0},
}

func proteinFactor(goal, activity string) float64 {
	return proteinFactors[goal][activity]
}

// SplitMacros divides a daily calorie target into grams of carbs and fat
// given the protein already chosen. Fat takes a fixed share of energy, so
// carbs absorb the remainder — which can go negative for a very low target
// against a heavy protein demand, hence the clamp.
func SplitMacros(kcal, proteinG float64) (carbsG, fatG float64) {
	fatG = (kcal * fatCaloriePct) / kcalPerGramFat
	carbsG = (kcal - proteinG*kcalPerGramMacro - fatG*kcalPerGramFat) / kcalPerGramMacro
	if carbsG < 0 {
		carbsG = 0
	}
	return carbsG, fatG
}

func Calculate(in Input, currentYear int) (Targets, error) {
	if in.Sex != "male" && in.Sex != "female" {
		return Targets{}, fmt.Errorf("onboarding: sex must be male or female")
	}
	if in.WeightKg < minWeightKg || in.WeightKg > maxWeightKg {
		return Targets{}, fmt.Errorf("onboarding: weight_kg out of range")
	}
	if in.HeightCm < minHeightCm || in.HeightCm > maxHeightCm {
		return Targets{}, fmt.Errorf("onboarding: height_cm out of range")
	}
	age := currentYear - in.BirthYear
	if age <= 0 || age > maxAgeYears {
		return Targets{}, fmt.Errorf("onboarding: birth_year out of range")
	}
	factor, ok := activityFactors[in.ActivityLevel]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid activity_level")
	}
	if !validGoals[in.Goal] {
		return Targets{}, fmt.Errorf("onboarding: invalid goal")
	}
	// Maintenance has no destination, so pace is ignored rather than
	// validated — the client does not render the control for that goal,
	// and the adjustment below is zero whatever the value holds.
	if in.Goal != "maintenance" {
		if in.PaceKgPerWeek < 0 {
			return Targets{}, fmt.Errorf("onboarding: pace_kg_per_week must not be negative")
		}
		if in.PaceKgPerWeek > in.WeightKg*maxPaceFractionOfBodyweight {
			return Targets{}, fmt.Errorf("onboarding: pace_kg_per_week exceeds 1%% of bodyweight")
		}
		// GoalWeightKg stays optional (see the Input doc comment), but once
		// supplied it must be a plausible body weight and must point the
		// direction the goal actually moves — otherwise a target_date gets
		// derived and stored for a journey the calorie target moves away
		// from (handler.go takes math.Abs, so it never notices on its own).
		if in.GoalWeightKg > 0 {
			if in.GoalWeightKg < minWeightKg || in.GoalWeightKg > maxWeightKg {
				return Targets{}, fmt.Errorf("onboarding: goal_weight_kg out of range")
			}
			if in.Goal == "fat_loss" && in.GoalWeightKg > in.WeightKg {
				return Targets{}, fmt.Errorf("onboarding: goal_weight_kg is above weight_kg for a fat_loss goal")
			}
			if in.Goal == "muscle_gain" && in.GoalWeightKg < in.WeightKg {
				return Targets{}, fmt.Errorf("onboarding: goal_weight_kg is below weight_kg for a muscle_gain goal")
			}
		}
	}

	bmr := bmrWeightCoef*in.WeightKg + bmrHeightCoef*in.HeightCm - bmrAgeCoef*float64(age)
	if in.Sex == "male" {
		bmr += bmrMaleOffset
	} else {
		bmr += bmrFemaleOffset
	}
	if bmr <= 0 {
		// Each input passed its own range check, but the combination is
		// still physically incoherent (e.g. a very old, very light, very
		// short body) — this must never reach the macro split, which
		// assumes a positive calorie budget.
		return Targets{}, fmt.Errorf("onboarding: computed bmr is not positive")
	}
	tdee := bmr * factor

	// Pace drives the adjustment. This replaces a flat -500/0/+300 map that
	// handed every user the same deficit regardless of body size.
	adjust := 0.0
	switch in.Goal {
	case "fat_loss":
		adjust = -(in.PaceKgPerWeek * KcalPerKg) / daysPerWeek
	case "muscle_gain":
		adjust = (in.PaceKgPerWeek * KcalPerKg) / daysPerWeek
	}

	raw := tdee + adjust
	kcal := raw
	floored := false
	// Never hand out a target below resting burn.
	if kcal < bmr {
		kcal = bmr
		floored = true
	}

	refKg := in.WeightKg
	if in.Goal == "fat_loss" && in.GoalWeightKg > 0 {
		refKg = in.GoalWeightKg
	}
	perKg := proteinFactor(in.Goal, in.ActivityLevel)
	proteinG := perKg * refKg

	t := Targets{Bmr: bmr, Tdee: tdee, ProteinGPerKg: perKg, ProteinRefKg: refKg}
	if o := in.KcalOverride; o != nil {
		if *o < bmr-overrideEpsilon {
			return Targets{}, &OverrideError{CodeKcalBelowRestingBurn}
		}
		if *o > tdee*maxKcalOverrideTdeeMultiple+overrideEpsilon {
			return Targets{}, &OverrideError{CodeKcalAboveCeiling}
		}
		kcal, floored, t.KcalOverridden = *o, false, true
	}
	if o := in.ProteinOverrideG; o != nil {
		if *o < minProteinOverrideGPerKg*in.WeightKg-overrideEpsilon {
			return Targets{}, &OverrideError{CodeProteinBelowMin}
		}
		if *o > maxProteinOverrideGPerKg*in.WeightKg+overrideEpsilon {
			return Targets{}, &OverrideError{CodeProteinAboveMax}
		}
		if *o*kcalPerGramMacro > maxProteinOverrideKcalShare*kcal+overrideEpsilon {
			return Targets{}, &OverrideError{CodeProteinExceedsShare}
		}
		proteinG, t.ProteinOverridden = *o, true
	}
	t.Kcal, t.ProteinG, t.Floored = kcal, proteinG, floored
	t.CarbsG, t.FatG = SplitMacros(kcal, proteinG)
	return t, nil
}
