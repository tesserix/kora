package ingest

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type row struct {
	Name           string  `json:"name"`
	Brand          string  `json:"brand"`
	ServingDesc    string  `json:"serving_desc"`
	ServingGrams   float64 `json:"serving_grams"`
	KcalPer100g    float64 `json:"kcal_per_100g"`
	ProteinPer100g float64 `json:"protein_per_100g"`
	CarbsPer100g   float64 `json:"carbs_per_100g"`
	FatPer100g     float64 `json:"fat_per_100g"`
	FiberPer100g   float64 `json:"fiber_per_100g"`
	Barcode        string  `json:"barcode"`
}

// LoadFile parses a JSON array of food rows into FoodItems, stamping provenance
// and dropping rows without a name or a positive kcal figure.
func LoadFile(path, provenance string) ([]nutrition.FoodItem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ingest: read %s: %w", path, err)
	}
	var rows []row
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("ingest: parse %s: %w", path, err)
	}
	var items []nutrition.FoodItem
	for _, r := range rows {
		if r.Name == "" || r.KcalPer100g <= 0 {
			continue
		}
		item := nutrition.FoodItem{
			Name:           r.Name,
			Brand:          r.Brand,
			Provenance:     provenance,
			ServingDesc:    r.ServingDesc,
			ServingGrams:   r.ServingGrams,
			KcalPer100g:    r.KcalPer100g,
			ProteinPer100g: r.ProteinPer100g,
			CarbsPer100g:   r.CarbsPer100g,
			FatPer100g:     r.FatPer100g,
			FiberPer100g:   r.FiberPer100g,
		}
		if r.Barcode != "" {
			b := r.Barcode
			item.Barcode = &b
		}
		items = append(items, item)
	}
	return items, nil
}
