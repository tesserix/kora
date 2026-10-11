package nutrition

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// OFFNutriments decodes OFF's gram-based per-100 g values into Kora's units.
type OFFNutriments struct {
	EnergyKcal100g float64
	Protein100g    float64
	Carbs100g      float64
	Fat100g        float64
	Fiber100g      float64
	Complete       bool
	Nutrients      Nutrients
}

// UnmarshalJSON accepts OFF's numeric strings while preserving missing values.
func (n *OFFNutriments) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*n = OFFNutriments{}
	n.Complete = true
	for key, target := range map[string]*float64{
		"energy-kcal_100g":   &n.EnergyKcal100g,
		"proteins_100g":      &n.Protein100g,
		"carbohydrates_100g": &n.Carbs100g,
		"fat_100g":           &n.Fat100g,
		"fiber_100g":         &n.Fiber100g,
	} {
		value := offMeasurement(raw[key], 1, 100000000)
		if value == nil {
			n.Complete = false
		} else {
			*target = *value
		}
	}
	n.Nutrients = Nutrients{
		SugarPer100g:         offMeasurement(raw["sugars_100g"], 1, 100),
		SaturatedFatPer100g:  offMeasurement(raw["saturated-fat_100g"], 1, 100),
		CholesterolMgPer100g: offMeasurement(raw["cholesterol_100g"], 1000, 100000),
		SodiumMgPer100g:      offMeasurement(raw["sodium_100g"], 1000, 100000),
		CalciumMgPer100g:     offMeasurement(raw["calcium_100g"], 1000, 100000),
		IronMgPer100g:        offMeasurement(raw["iron_100g"], 1000, 100000),
		PotassiumMgPer100g:   offMeasurement(raw["potassium_100g"], 1000, 100000),
		MagnesiumMgPer100g:   offMeasurement(raw["magnesium_100g"], 1000, 100000),
		PhosphorusMgPer100g:  offMeasurement(raw["phosphorus_100g"], 1000, 100000),
		ZincMgPer100g:        offMeasurement(raw["zinc_100g"], 1000, 100000),
		SeleniumUgPer100g:    offMeasurement(raw["selenium_100g"], 1000000, 100000000),
		IodineUgPer100g:      offMeasurement(raw["iodine_100g"], 1000000, 100000000),
		VitaminCMgPer100g:    offMeasurement(raw["vitamin-c_100g"], 1000, 100000),
		VitaminDUgPer100g:    offMeasurement(raw["vitamin-d_100g"], 1000000, 100000000),
		VitaminEMgPer100g:    offMeasurement(raw["vitamin-e_100g"], 1000, 100000),
		VitaminKUgPer100g:    offMeasurement(raw["vitamin-k_100g"], 1000000, 100000000),
		ThiaminMgPer100g:     offMeasurement(raw["vitamin-b1_100g"], 1000, 100000),
		RiboflavinMgPer100g:  offMeasurement(raw["vitamin-b2_100g"], 1000, 100000),
		NiacinMgPer100g:      offMeasurement(raw["vitamin-pp_100g"], 1000, 100000),
		VitaminB6MgPer100g:   offMeasurement(raw["vitamin-b6_100g"], 1000, 100000),
		VitaminB12UgPer100g:  offMeasurement(raw["vitamin-b12_100g"], 1000000, 100000000),
		FolateUgPer100g:      offMeasurement(raw["vitamin-b9_100g"], 1000000, 100000000),
	}
	return nil
}

func offMeasurement(data json.RawMessage, scale, maximum float64) *float64 {
	text := strings.TrimSpace(string(data))
	if strings.HasPrefix(text, "\"") {
		var value string
		if err := json.Unmarshal(data, &value); err != nil {
			return nil
		}
		text = strings.TrimSpace(value)
	}
	value, err := strconv.ParseFloat(text, 64)
	value *= scale
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > maximum {
		return nil
	}
	return &value
}
