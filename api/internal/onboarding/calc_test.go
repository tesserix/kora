package onboarding

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func approx(t *testing.T, want, got, tol float64) {
	t.Helper()
	require.LessOrEqual(t, math.Abs(want-got), tol, "want ~%.4f got %.4f", want, got)
}

// goldenCase mirrors testdata/golden_targets.json, which is also asserted by
// apps/mobile/src/lib/__tests__/plan.test.ts. Changing one implementation
// without the other turns the opposite language's suite red — that is the
// point of the file.
type goldenCase struct {
	Name          string  `json:"name"`
	Sex           string  `json:"sex"`
	Age           int     `json:"age"`
	HeightCm      float64 `json:"height_cm"`
	WeightKg      float64 `json:"weight_kg"`
	ActivityLevel string  `json:"activity_level"`
	Goal          string  `json:"goal"`
	PaceKgPerWeek float64 `json:"pace_kg_per_week"`
	Bmr           float64 `json:"bmr"`
	Tdee          float64 `json:"tdee"`
	Kcal          float64 `json:"kcal"`
	ProteinG      float64 `json:"protein_g"`
	CarbsG        float64 `json:"carbs_g"`
	FatG          float64 `json:"fat_g"`
	Floored       bool    `json:"floored"`
}

func TestCalculateMatchesGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden_targets.json")
	require.NoError(t, err)
	var cases []goldenCase
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	const currentYear = 2026
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Calculate(Input{
				Sex:           c.Sex,
				BirthYear:     currentYear - c.Age,
				HeightCm:      c.HeightCm,
				WeightKg:      c.WeightKg,
				ActivityLevel: c.ActivityLevel,
				Goal:          c.Goal,
				PaceKgPerWeek: c.PaceKgPerWeek,
			}, currentYear)
			require.NoError(t, err)
			approx(t, c.Kcal, got.Kcal, 0.001)
			approx(t, c.ProteinG, got.ProteinG, 0.001)
			approx(t, c.CarbsG, got.CarbsG, 0.001)
			approx(t, c.FatG, got.FatG, 0.001)
		})
	}
}

// The floor is the safety-critical line: without it a 40kg user asking for
// 1kg/week is handed a negative target.
func TestCalculateNeverReturnsBelowRestingBurn(t *testing.T) {
	got, err := Calculate(Input{
		Sex: "female", BirthYear: 1936, HeightCm: 150, WeightKg: 40,
		ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 1,
	}, 2026)
	require.NoError(t, err)
	approx(t, 726.5, got.Kcal, 0.001)
}

func TestCalculateMaintenanceIgnoresPace(t *testing.T) {
	withPace, err := Calculate(Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "maintenance", PaceKgPerWeek: 1,
	}, 2025)
	require.NoError(t, err)
	withoutPace, err := Calculate(Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "maintenance",
	}, 2025)
	require.NoError(t, err)
	require.Equal(t, withoutPace.Kcal, withPace.Kcal)
	approx(t, 2759, withPace.Kcal, 1)
}

func TestCalculateRejectsInvalidInput(t *testing.T) {
	base := Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "fat_loss", PaceKgPerWeek: 0.5,
	}
	t.Run("sex", func(t *testing.T) {
		in := base
		in.Sex = "other"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("activity", func(t *testing.T) {
		in := base
		in.ActivityLevel = "olympian"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("goal", func(t *testing.T) {
		in := base
		in.Goal = "vibes"
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("pace below zero", func(t *testing.T) {
		in := base
		in.PaceKgPerWeek = -0.5
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("pace above one percent of bodyweight", func(t *testing.T) {
		in := base // 80kg, so the cap is 0.8
		in.PaceKgPerWeek = 1
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("birth year", func(t *testing.T) {
		in := base
		in.BirthYear = 2030
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
}

// The carbs clamp is unreachable through Calculate once kcal is floored at
// BMR, so it is exercised where it lives instead of through a contrived
// whole-input case.
func TestSplitMacrosClampsCarbsToZero(t *testing.T) {
	// 100kg of protein demand (200g = 800kcal) against a 600kcal budget.
	_, carbs, _ := SplitMacros(600, 100)
	require.Equal(t, 0.0, carbs)
}

func TestSplitMacrosSplitsNormally(t *testing.T) {
	protein, carbs, fat := SplitMacros(2000, 80)
	approx(t, 160, protein, 0.001)   // 2g/kg
	approx(t, 55.5555, fat, 0.001)   // 25% of 2000 / 9
	approx(t, 215, carbs, 0.001)     // (2000 - 640 - 500) / 4
}
