package onboarding

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func approx(t *testing.T, want, got, tol float64) {
	t.Helper()
	require.LessOrEqual(t, math.Abs(want-got), tol, "want ~%.1f got %.1f", want, got)
}

func TestCalculateMaleMaintenance(t *testing.T) {
	// 30yo male (born 1995 given year 2025), 180cm, 80kg, moderate, maintenance.
	// BMR = 10*80 + 6.25*180 - 5*30 + 5 = 1780; TDEE = 1780*1.55 = 2759.
	got, err := Calculate(Input{Sex: "male", BirthYear: 1995, HeightCm: 180, WeightKg: 80, ActivityLevel: "moderate", Goal: "maintenance"}, 2025)
	require.NoError(t, err)
	approx(t, 2759, got.Kcal, 5)
	// protein 2.0 g/kg = 160g
	approx(t, 160, got.ProteinG, 1)
}

func TestCalculateFemaleFatLoss(t *testing.T) {
	// 25yo female, 165cm, 65kg, light, fat_loss.
	// BMR = 10*65 + 6.25*165 - 5*25 - 161 = 1395.25; TDEE = *1.375 = 1918.47; fat_loss -500 = 1418.
	got, err := Calculate(Input{Sex: "female", BirthYear: 2000, HeightCm: 165, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.NoError(t, err)
	approx(t, 1418, got.Kcal, 5)
}

func TestCalculateClampsCarbsToZero(t *testing.T) {
	// 90yo female (born 1935 given year 2025), 150cm, 40kg, sedentary, fat_loss.
	// BMR = 10*40 + 6.25*150 - 5*90 - 161 = 726.5 -> kcal = 726.5*1.2 - 500 = 371.80.
	// protein = 2*40 = 80g (320 kcal); fat = 25% of 371.80 / 9 = 10.33g (92.95 kcal).
	// pre-clamp carbs = (371.80 - 320 - 92.95) / 4 = -10.29g, which must clamp to 0.
	got, err := Calculate(Input{Sex: "female", BirthYear: 1935, HeightCm: 150, WeightKg: 40, ActivityLevel: "sedentary", Goal: "fat_loss"}, 2025)
	require.NoError(t, err)
	require.Equal(t, 0.0, got.CarbsG)
}

func TestCalculateRejectsBadInput(t *testing.T) {
	_, err := Calculate(Input{Sex: "other", BirthYear: 2000, HeightCm: 165, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.Error(t, err)
	_, err = Calculate(Input{Sex: "male", BirthYear: 2000, HeightCm: 0, WeightKg: 65, ActivityLevel: "light", Goal: "fat_loss"}, 2025)
	require.Error(t, err)
}
