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
}

type Targets struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

var activityFactors = map[string]float64{
	"sedentary":   1.2,
	"light":       1.375,
	"moderate":    1.55,
	"active":      1.725,
	"very_active": 1.9,
}

var goalAdjustments = map[string]float64{
	"fat_loss":    -500,
	"maintenance": 0,
	"muscle_gain": 300,
}

func Calculate(in Input, currentYear int) (Targets, error) {
	if in.Sex != "male" && in.Sex != "female" {
		return Targets{}, fmt.Errorf("onboarding: sex must be male or female")
	}
	if in.HeightCm <= 0 || in.WeightKg <= 0 {
		return Targets{}, fmt.Errorf("onboarding: height and weight must be positive")
	}
	age := currentYear - in.BirthYear
	if age <= 0 || age > 120 {
		return Targets{}, fmt.Errorf("onboarding: birth_year out of range")
	}
	factor, ok := activityFactors[in.ActivityLevel]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid activity_level")
	}
	adjust, ok := goalAdjustments[in.Goal]
	if !ok {
		return Targets{}, fmt.Errorf("onboarding: invalid goal")
	}

	bmr := 10*in.WeightKg + 6.25*in.HeightCm - 5*float64(age)
	if in.Sex == "male" {
		bmr += 5
	} else {
		bmr -= 161
	}
	kcal := bmr*factor + adjust

	proteinG := 2.0 * in.WeightKg // 2 g/kg bodyweight
	fatG := (kcal * 0.25) / 9     // 25% of calories from fat
	carbsG := (kcal - proteinG*4 - fatG*9) / 4
	if carbsG < 0 {
		carbsG = 0
	}

	return Targets{Kcal: kcal, ProteinG: proteinG, CarbsG: carbsG, FatG: fatG}, nil
}
