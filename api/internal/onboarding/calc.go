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
}

type Targets struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
	// Floored reports that the resting-burn clamp bound — the requested
	// pace asked for a target below BMR and did not get it. Callers
	// surface this to the user rather than silently showing a number
	// that stopped obeying them.
	Floored bool `json:"floored"`
}

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
	proteinGPerKg    = 2.0
	fatCaloriePct    = 0.25
	kcalPerGramFat   = 9.0
	kcalPerGramMacro = 4.0 // protein and carbs

	// KcalPerKg is the energy density of body mass used to turn a weekly
	// rate of change into a daily calorie adjustment.
	KcalPerKg = 7700.0

	daysPerWeek = 7.0

	// maxPaceFractionOfBodyweight caps the weekly rate at 1% of bodyweight.
	// This is the primary safety limit; the BMR floor below is the backstop
	// for anything that slips past it.
	maxPaceFractionOfBodyweight = 0.01
)

// SplitMacros divides a daily calorie target into grams of protein, carbs and
// fat. Protein scales with bodyweight and fat takes a fixed share of energy,
// so carbs absorb the remainder — which can go negative for a very low target
// against a heavy body, hence the clamp.
func SplitMacros(kcal, weightKg float64) (proteinG, carbsG, fatG float64) {
	proteinG = proteinGPerKg * weightKg
	fatG = (kcal * fatCaloriePct) / kcalPerGramFat
	carbsG = (kcal - proteinG*kcalPerGramMacro - fatG*kcalPerGramFat) / kcalPerGramMacro
	if carbsG < 0 {
		carbsG = 0
	}
	return proteinG, carbsG, fatG
}

func Calculate(in Input, currentYear int) (Targets, error) {
	if in.Sex != "male" && in.Sex != "female" {
		return Targets{}, fmt.Errorf("onboarding: sex must be male or female")
	}
	if in.HeightCm <= 0 || in.WeightKg <= 0 {
		return Targets{}, fmt.Errorf("onboarding: height and weight must be positive")
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
	}

	bmr := bmrWeightCoef*in.WeightKg + bmrHeightCoef*in.HeightCm - bmrAgeCoef*float64(age)
	if in.Sex == "male" {
		bmr += bmrMaleOffset
	} else {
		bmr += bmrFemaleOffset
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

	proteinG, carbsG, fatG := SplitMacros(kcal, in.WeightKg)
	return Targets{Kcal: kcal, ProteinG: proteinG, CarbsG: carbsG, FatG: fatG, Floored: floored}, nil
}
