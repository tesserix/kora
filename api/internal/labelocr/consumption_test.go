package labelocr

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConsumptionRequiresPositiveAmountWithCompatibleUnit(t *testing.T) {
	energy := 200.0
	label := Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}}
	for _, amount := range []*Consumption{nil, {Value: -50, Unit: "g"}, {Value: 0, Unit: "g"}, {Value: 50}, {Value: 50, Unit: "ml"}} {
		plan := PlanConsumption(label, amount)
		require.Equal(t, "ask_amount", plan.Action)
		require.Nil(t, plan.Nutrients)
	}
	plan := PlanConsumption(label, &Consumption{Value: 50, Unit: "g"})
	require.Equal(t, "calculate", plan.Action)
	require.Equal(t, 100.0, *plan.Nutrients.EnergyKcal)
	require.Nil(t, plan.Nutrients.ProteinG, "unknown nutrients must not become zero")
}

func TestConsumptionDoesNotCalculateConflictingOrNonFiniteAmounts(t *testing.T) {
	energy := 200.0
	label := Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}}
	for _, amount := range []*Consumption{
		{Value: math.NaN(), Unit: "g"}, {Value: math.Inf(1), Unit: "g"},
		{Value: math.MaxFloat64, Unit: "g"}, {Value: 50, Unit: "g", Conflicting: true},
	} {
		plan := PlanConsumption(label, amount)
		require.Equal(t, "ask_amount", plan.Action)
		require.Nil(t, plan.Nutrients)
	}
}

func TestConsumptionDoesNotTurnPositiveNutritionIntoZeroByUnderflow(t *testing.T) {
	energy := 200.0
	label := Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}}
	plan := PlanConsumption(label, &Consumption{Value: math.SmallestNonzeroFloat64, Unit: "g"})
	require.Equal(t, "ask_amount", plan.Action)
	require.Nil(t, plan.Nutrients)
}

func TestConsumptionUsesExplicitServingsAndPreservesZeroEnergy(t *testing.T) {
	energy, protein := 0.0, 3.0
	label := Label{Basis: "per_serving", PerServing: Nutrients{EnergyKcal: &energy, ProteinG: &protein}}
	plan := PlanConsumption(label, &Consumption{Value: 2, Unit: "servings"})
	require.Equal(t, "calculate", plan.Action)
	require.Equal(t, 0.0, *plan.Nutrients.EnergyKcal)
	require.Equal(t, 6.0, *plan.Nutrients.ProteinG)
	require.Equal(t, "ask_amount", PlanConsumption(label, nil).Action)
	require.Equal(t, "ask_amount", PlanConsumption(label, &Consumption{Value: 50, Unit: "g"}).Action)
}

func TestConsumptionKeepsVolumeDistinctFromMassAndPrintedServing(t *testing.T) {
	energy, serving := 42.0, 50.0
	label := Label{Basis: BasisPer100ml, Per100: Nutrients{EnergyKcal: &energy}, ServingGrams: &serving}
	require.Equal(t, "ask_amount", PlanConsumption(label, nil).Action)
	require.Equal(t, "ask_amount", PlanConsumption(label, &Consumption{Value: 250, Unit: "g"}).Action)
	plan := PlanConsumption(label, &Consumption{Value: 250, Unit: "ml"})
	require.Equal(t, "calculate", plan.Action)
	require.Equal(t, 105.0, *plan.Nutrients.EnergyKcal)
}

func TestConsumptionHonorsTheOCRValidatorReviewDecision(t *testing.T) {
	for _, confidence := range []float64{0.4, 0.9} {
		label, err := Check(map[string]Field{
			"per_100g.energy_kcal": {Value: []byte(`200`), Confidence: confidence},
		}, nil)
		require.NoError(t, err)
		plan := PlanConsumption(label, &Consumption{Value: 50, Unit: "g"})
		if confidence < 0.6 {
			require.Equal(t, "review", plan.Action)
			require.Nil(t, plan.Nutrients)
		} else {
			require.Equal(t, "calculate", plan.Action)
			require.Equal(t, 100.0, *plan.Nutrients.EnergyKcal)
		}
	}
}

func FuzzConsumptionNeverCalculatesInvalidMeasurements(f *testing.F) {
	f.Add(200.0, 50.0, "g", false)
	f.Add(0.0, 1.0, "g", false)
	f.Add(200.0, -50.0, "g", false)
	f.Add(200.0, 50.0, "ml", false)
	f.Fuzz(func(t *testing.T, energy, value float64, unit string, conflicting bool) {
		label := Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}}
		plan := PlanConsumption(label, &Consumption{Value: value, Unit: unit, Conflicting: conflicting})
		if plan.Action != "calculate" {
			require.Nil(t, plan.Nutrients)
			return
		}
		require.False(t, conflicting)
		require.Equal(t, "g", unit)
		require.True(t, value > 0 && !math.IsInf(value, 0))
		require.True(t, energy >= 0 && energy <= 900)
		require.NotNil(t, plan.Nutrients.EnergyKcal)
		require.False(t, math.IsInf(*plan.Nutrients.EnergyKcal, 0) || math.IsNaN(*plan.Nutrients.EnergyKcal))
		require.Nil(t, plan.Nutrients.ProteinG)
	})
}

func TestConsumptionRejectsMissingOrUnsafeLabelEvidence(t *testing.T) {
	energy, negative, nan := 200.0, -1.0, math.NaN()
	for _, tc := range []struct {
		name   string
		label  Label
		action string
	}{
		{"missing_basis", Label{Per100: Nutrients{EnergyKcal: &energy}}, "retake"},
		{"missing_energy", Label{Basis: BasisPer100g}, "retake"},
		{"non_finite", Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &nan}}, "retake"},
		{"negative_energy", Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &negative}}, "review"},
		{"review_flag", Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}, NeedsReview: true}, "review"},
		{"unresolved_issue", Label{Basis: BasisPer100g, Per100: Nutrients{EnergyKcal: &energy}, Issues: []string{"partial"}}, "review"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, amount := range []*Consumption{nil, {Value: 50, Unit: "g"}} {
				plan := PlanConsumption(tc.label, amount)
				require.Equal(t, tc.action, plan.Action)
				require.Nil(t, plan.Nutrients)
			}
		})
	}
}
