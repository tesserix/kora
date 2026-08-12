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
			require.Equal(t, c.Floored, got.Floored)
		})
	}
}

// The floor is the safety-critical line: without it this 40kg user's
// target computes to 431.8 kcal, well under her 726.5 resting burn.
func TestCalculateNeverReturnsBelowRestingBurn(t *testing.T) {
	got, err := Calculate(Input{
		Sex: "female", BirthYear: 1936, HeightCm: 150, WeightKg: 40,
		ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 0.4,
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
	withNegativePace, err := Calculate(Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "maintenance", PaceKgPerWeek: -1,
	}, 2025)
	require.NoError(t, err)
	require.Equal(t, withoutPace.Kcal, withPace.Kcal)
	require.Equal(t, withoutPace.Kcal, withNegativePace.Kcal)
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

// These payloads all returned err=nil before the server mirrored the
// client's plausibility bounds — the whole-branch review traced each one to
// a concrete unsafe or nonsensical output (an ED-risk-range prescription, a
// negative calorie target, and a six-figure calorie target that scales
// unboundedly with weight). Every case here must now error.
func TestCalculateRejectsImplausibleBodyMetrics(t *testing.T) {
	t.Run("underweight input prescribes an ED-risk-range target", func(t *testing.T) {
		// weight_kg: 19, height_cm: 150, female, age 16, sedentary, fat_loss,
		// pace 0.19 -> previously Kcal 886.5, Floored true. go-shared's
		// guardrail policy treats <=1200 kcal average intake as an ED-risk
		// signal; this path prescribed 886 directly.
		_, err := Calculate(Input{
			Sex: "female", BirthYear: 2010, HeightCm: 150, WeightKg: 19,
			ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 0.19,
		}, 2026)
		require.Error(t, err)
	})

	t.Run("degenerate measurements produce a negative calorie target", func(t *testing.T) {
		// weight_kg: 0.1, height_cm: 1, age 100 -> previously Kcal -653.75.
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1926, HeightCm: 1, WeightKg: 0.1,
			ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 0.001,
		}, 2026)
		require.Error(t, err)
	})

	t.Run("huge weight lets pace scale the adjustment without bound", func(t *testing.T) {
		// weight_kg: 10000, height_cm: 170, pace 100 -> previously Kcal
		// 100917.5. The old flat -500 adjustment could not scale with
		// weight; adjust = pace * 7700 / 7 with pace <= weight * 0.01 turns
		// an unbounded measurement into an unbounded adjustment.
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1996, HeightCm: 170, WeightKg: 10000,
			ActivityLevel: "sedentary", Goal: "fat_loss", PaceKgPerWeek: 100,
		}, 2026)
		require.Error(t, err)
	})

	t.Run("each individually-in-range input still yields a non-positive bmr", func(t *testing.T) {
		// weight 20 (the floor), height 50 (the floor), age 120 (the ceiling)
		// each pass their own range check, but the combination is not a
		// physically coherent body — bmr computes negative and must be
		// caught before it reaches the macro split.
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1906, HeightCm: 50, WeightKg: 20,
			ActivityLevel: "sedentary", Goal: "maintenance",
		}, 2026)
		require.Error(t, err)
	})
}

func TestCalculateRejectsGoalWeightOutsideValidRange(t *testing.T) {
	base := Input{
		Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
		ActivityLevel: "moderate", Goal: "muscle_gain", PaceKgPerWeek: 0.25,
	}
	t.Run("too low", func(t *testing.T) {
		in := base
		in.GoalWeightKg = 19
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
	t.Run("too high", func(t *testing.T) {
		in := base
		in.GoalWeightKg = 501
		_, err := Calculate(in, 2025)
		require.Error(t, err)
	})
}

func TestCalculateRejectsGoalWeightContradictingGoal(t *testing.T) {
	t.Run("fat_loss goal weight above current weight", func(t *testing.T) {
		// A fat_loss payload asking to land ABOVE the current weight moves
		// away from the goal the calorie deficit is computed for.
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 70,
			ActivityLevel: "moderate", Goal: "fat_loss", PaceKgPerWeek: 0.25,
			GoalWeightKg: 120,
		}, 2025)
		require.Error(t, err)
	})

	t.Run("muscle_gain goal weight below current weight", func(t *testing.T) {
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
			ActivityLevel: "moderate", Goal: "muscle_gain", PaceKgPerWeek: 0.25,
			GoalWeightKg: 70,
		}, 2025)
		require.Error(t, err)
	})

	t.Run("goal weight equal to current weight is not a contradiction", func(t *testing.T) {
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
			ActivityLevel: "moderate", Goal: "fat_loss", PaceKgPerWeek: 0.25,
			GoalWeightKg: 80,
		}, 2025)
		require.NoError(t, err)
	})

	t.Run("maintenance ignores goal weight entirely", func(t *testing.T) {
		_, err := Calculate(Input{
			Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80,
			ActivityLevel: "moderate", Goal: "maintenance",
			GoalWeightKg: 5,
		}, 2025)
		require.NoError(t, err)
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
	approx(t, 160, protein, 0.001) // 2g/kg
	approx(t, 55.5555, fat, 0.001) // 25% of 2000 / 9
	approx(t, 215, carbs, 0.001)   // (2000 - 640 - 500) / 4
}
