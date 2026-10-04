package labelocr

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func fields(t *testing.T, values map[string]any) map[string]Field {
	t.Helper()
	out := map[string]Field{}
	for name, v := range values {
		raw, err := json.Marshal(v)
		require.NoError(t, err)
		out[name] = Field{Value: raw, Confidence: 0.9}
	}
	return out
}

func TestCheckReadsBothColumnsOfAConsistentPanel(t *testing.T) {
	label, err := Check(fields(t, map[string]any{
		"serving_size":             map[string]any{"amount": 30, "unit": "g"},
		"servings_per_pack":        8,
		"barcode":                  "9300605000117",
		"per_serving.energy_kj":    540,
		"per_serving.protein_g":    3.2,
		"per_100g.energy_kj":       1800,
		"per_100g.energy_kcal":     430,
		"per_100g.protein_g":       10.7,
		"per_100g.fat_g":           5.0,
		"per_100g.saturated_fat_g": 1.0,
		"per_100g.carbohydrate_g":  67.0,
		"per_100g.sugars_g":        15.0,
		"per_100g.fibre_g":         10.0,
		"per_100g.sodium_mg":       400,
	}), nil)

	require.NoError(t, err)
	assert.Equal(t, BasisPer100g, label.Basis)
	assert.InDelta(t, 430, *label.Per100.EnergyKcal, 1e-9)
	assert.InDelta(t, 10.7, *label.Per100.ProteinG, 1e-9)
	assert.InDelta(t, 30, *label.ServingGrams, 1e-9)
	assert.InDelta(t, 129.06, *label.PerServing.EnergyKcal, 0.01, "kJ converts to kcal")
	assert.Equal(t, "9300605000117", label.Barcode)
	assert.Empty(t, label.Issues)
	assert.False(t, label.NeedsReview)
}

func TestCheckDerivesPer100gFromAServingOnlyPanel(t *testing.T) {
	label, err := Check(fields(t, map[string]any{
		"serving_size":               map[string]any{"amount": 55, "unit": "g"},
		"per_serving.energy_kcal":    230,
		"per_serving.fat_g":          8,
		"per_serving.carbohydrate_g": 37,
		"per_serving.protein_g":      3,
	}), nil)

	require.NoError(t, err)
	assert.Equal(t, BasisPer100g, label.Basis)
	assert.InDelta(t, 418.18, *label.Per100.EnergyKcal, 0.01)
	assert.InDelta(t, 14.55, *label.Per100.FatG, 0.01)
	assert.Contains(t, label.Issues, IssueDerivedFromServing)
	assert.True(t, label.NeedsReview, "a derived column is shown for confirmation, not trusted")
}

func TestCheckFlagsInconsistentPanelsWithoutCorrectingThem(t *testing.T) {
	label, err := Check(fields(t, map[string]any{
		"per_100g.energy_kcal": 950,
		"per_100g.protein_g":   20,
		"per_100g.sodium_mg":   45000,
	}), []Failure{{Code: "energy_atwater_mismatch", Severity: "warning"}})

	require.NoError(t, err)
	assert.InDelta(t, 950, *label.Per100.EnergyKcal, 1e-9)
	assert.InDelta(t, 45000, *label.Per100.SodiumMg, 1e-9)
	assert.ElementsMatch(t, []string{"energy_atwater_mismatch", IssueOutOfRange}, label.Issues)
	assert.True(t, label.NeedsReview)
}

func TestCheckSendsLowConfidenceReadsToReview(t *testing.T) {
	read := fields(t, map[string]any{"per_100g.energy_kcal": 120})
	read["per_100g.energy_kcal"] = Field{Value: read["per_100g.energy_kcal"].Value, Confidence: 0.4}

	label, err := Check(read, nil)

	require.NoError(t, err)
	assert.Equal(t, []string{IssueLowConfidence}, label.Issues)
	assert.True(t, label.NeedsReview)
}

func TestCheckRejectsUnreadablePanels(t *testing.T) {
	_, err := Check(nil, []Failure{{Code: "nutrition_panel_not_found", Severity: "error"}})
	assert.True(t, errors.Is(err, ErrUnreadable))

	_, err = Check(fields(t, map[string]any{"per_serving.protein_g": 3}), nil)
	assert.True(t, errors.Is(err, ErrUnreadable), "no energy and no serving mass leaves nothing to log")
}

func TestCheckKeepsPer100mlAndIgnoresNonMassServings(t *testing.T) {
	label, err := Check(fields(t, map[string]any{
		"serving_size":             map[string]any{"amount": 1, "unit": "cup"},
		"per_100ml.energy_kcal":    42,
		"per_100ml.sugars_g":       10.6,
		"per_100ml.carbohydrate_g": 10.6,
	}), nil)

	require.NoError(t, err)
	assert.Equal(t, BasisPer100ml, label.Basis)
	assert.Nil(t, label.ServingGrams)
	assert.InDelta(t, 42, *label.Per100.EnergyKcal, 1e-9)
}
