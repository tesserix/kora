package ingest

import (
	"encoding/json"
	"fmt"
	"io"
)

// USDA FoodData Central nutrient IDs. 1062 is Energy in kJ and is deliberately
// absent: using it would inflate every kcal figure by ~4.184x.
const (
	srNutrientKcal    = 1008
	srNutrientProtein = 1003
	srNutrientCarbs   = 1005
	srNutrientFat     = 1004
	srNutrientFiber   = 1079
)

// srDefaultServingGrams is the fallback serve for records with no usable
// foodPortions entry. 0 would make any portion-scaled log silently zero.
const srDefaultServingGrams = 100.0

// srExpectedRecords pre-sizes the output slice; SR Legacy 2021-10-28 holds
// 7,793 records. Only an allocation hint — a different export still works.
const srExpectedRecords = 8000

// SRLegacyStats reports what a conversion did. Skipped counts records dropped
// for missing a required nutrient.
type SRLegacyStats struct {
	Converted int
	Skipped   int
}

type srFood struct {
	Description   string `json:"description"`
	FoodNutrients []struct {
		Nutrient struct {
			ID int `json:"id"`
		} `json:"nutrient"`
		Amount float64 `json:"amount"`
	} `json:"foodNutrients"`
	FoodPortions []struct {
		Modifier   string  `json:"modifier"`
		GramWeight float64 `json:"gramWeight"`
	} `json:"foodPortions"`
}

// ConvertSRLegacy streams USDA SR Legacy JSON and writes a JSON array of ingest
// rows. It streams record-by-record because the real file is 210 MB — decoding
// it whole would need over a gigabyte of heap for a build-time tool.
func ConvertSRLegacy(r io.Reader, w io.Writer) (SRLegacyStats, error) {
	var stats SRLegacyStats
	dec := json.NewDecoder(r)

	// Walk into {"SRLegacyFoods":[ ... ]} by token so the array elements can be
	// decoded one at a time.
	if _, err := dec.Token(); err != nil { // '{'
		return stats, fmt.Errorf("srlegacy: open object: %w", err)
	}
	if _, err := dec.Token(); err != nil { // "SRLegacyFoods"
		return stats, fmt.Errorf("srlegacy: key: %w", err)
	}
	if _, err := dec.Token(); err != nil { // '['
		return stats, fmt.Errorf("srlegacy: open array: %w", err)
	}

	rows := make([]row, 0, srExpectedRecords)
	for dec.More() {
		var f srFood
		if err := dec.Decode(&f); err != nil {
			return stats, fmt.Errorf("srlegacy: decode record: %w", err)
		}

		amounts := make(map[int]float64, len(f.FoodNutrients))
		for _, n := range f.FoodNutrients {
			amounts[n.Nutrient.ID] = n.Amount
		}

		kcal, okKcal := amounts[srNutrientKcal]
		protein, okProtein := amounts[srNutrientProtein]
		carbs, okCarbs := amounts[srNutrientCarbs]
		fat, okFat := amounts[srNutrientFat]
		if f.Description == "" || !okKcal || !okProtein || !okCarbs || !okFat || kcal <= 0 {
			stats.Skipped++
			continue
		}

		servingGrams, servingDesc := srDefaultServingGrams, fmt.Sprintf("%.0f g", srDefaultServingGrams)
		for _, p := range f.FoodPortions {
			if p.GramWeight <= 0 {
				continue
			}
			servingGrams = p.GramWeight
			if p.Modifier != "" {
				servingDesc = fmt.Sprintf("%s (%.0f g)", p.Modifier, p.GramWeight)
			} else {
				servingDesc = fmt.Sprintf("%.0f g", p.GramWeight)
			}
			break
		}

		rows = append(rows, row{
			Name:           f.Description,
			ServingDesc:    servingDesc,
			ServingGrams:   servingGrams,
			KcalPer100g:    kcal,
			ProteinPer100g: protein,
			CarbsPer100g:   carbs,
			FatPer100g:     fat,
			FiberPer100g:   amounts[srNutrientFiber], // absent -> 0
		})
		stats.Converted++
	}

	if err := json.NewEncoder(w).Encode(rows); err != nil {
		return stats, fmt.Errorf("srlegacy: encode: %w", err)
	}
	return stats, nil
}
