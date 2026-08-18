package ingest

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/tesserix/kora/api/internal/nutrition"
)

type row struct {
	Name         string  `json:"name"`
	Brand        string  `json:"brand"`
	ServingDesc  string  `json:"serving_desc"`
	ServingGrams float64 `json:"serving_grams"`
	// ServingUnits are the food's OWN named servings — "1 can (333 g)",
	// "1 cup (158 g)". They feed the second tier of ai.portionGramsFor, above
	// the generic phrase table, so "2 slices" resolves against THIS row's mass
	// rather than a table average.
	//
	// The column has existed on FoodItem all along; until now no source file
	// could reach it, because this struct had no field for it. AUSNUT's
	// measures workbook is the first to populate it (kora#212 follow-up).
	ServingUnits   []servingUnit `json:"serving_units"`
	KcalPer100g    float64       `json:"kcal_per_100g"`
	ProteinPer100g float64       `json:"protein_per_100g"`
	CarbsPer100g   float64       `json:"carbs_per_100g"`
	FatPer100g     float64       `json:"fat_per_100g"`
	FiberPer100g   float64       `json:"fiber_per_100g"`
	Barcode        string        `json:"barcode"`
	// Locale is set only by sources whose rows are not all one locale —
	// today just au_in_dishes.json, which mixes Indian and Australian dishes.
	// Everything else leaves it empty and takes nutrition.DeriveLocale's
	// provenance rule.
	Locale string `json:"locale"`
}

// servingUnit mirrors units.ServingUnit's JSON shape. Declared here rather
// than imported so the ingest schema stays a plain description of the file
// format, and a change to the units package cannot silently redefine what a
// committed data file means.
type servingUnit struct {
	Name       string  `json:"name"`
	Amount     float64 `json:"amount"`
	BaseAmount float64 `json:"base_amount"`
}

// encodeServingUnits validates and serialises a row's named servings.
//
// Entries are dropped rather than repaired: a zero or negative Amount would
// make ai.servingGramsFromPhrase divide by zero, and a nameless or massless
// entry can never match a phrase, so storing either is strictly worse than
// storing nothing. Returns nil when nothing survives, which leaves the column
// at its '[]' default.
func encodeServingUnits(in []servingUnit) json.RawMessage {
	out := make([]servingUnit, 0, len(in))
	for _, u := range in {
		if u.Name == "" || u.Amount <= 0 || u.BaseAmount <= 0 {
			continue
		}
		out = append(out, u)
	}
	if len(out) == 0 {
		return nil
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		// Unreachable for a slice of plain scalars, and a data file is not
		// worth failing the whole ingest over — degrade to no named servings.
		return nil
	}
	return encoded
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
		// Drop unnamed and NEGATIVE-energy rows only. A kcal of exactly 0 is a
		// real measurement, not missing data, and conflating the two removed
		// every zero-energy food from the index: water, tap water, plain
		// mineral water, tea and coffee brewed without milk. Measured
		// consequence — the index held ZERO rows with kcal <= 0, so "water"
		// resolved to `Coconut Water` at 15.3 kcal.
		//
		// Sources that genuinely lack an energy figure express it as a missing
		// or negative value, which is still rejected. See kora#219's sibling
		// discussion; the rule is "unknown is not zero".
		if r.Name == "" || r.KcalPer100g < 0 {
			continue
		}
		name, brand := r.Name, r.Brand
		// USDA carries chain and packaged items as `McDONALD'S, FILET-O-FISH`,
		// with the brand in the name and the brand column empty. Move it into
		// the column it belongs in, which is what lets the existing
		// DeriveEntityType type these rows as branded_product with no rule
		// change, and what makes brand matching able to see them at all.
		// See nutrition.SplitEmbeddedBrand and kora#212.
		if provenance == nutrition.ProvenanceUSDA && brand == "" {
			if extracted, rest := nutrition.SplitEmbeddedBrand(name); extracted != "" {
				name, brand = rest, extracted
			}
		}
		locale := r.Locale
		if locale == "" {
			locale = nutrition.DeriveLocale(provenance)
		}
		item := nutrition.FoodItem{
			Name:           name,
			Brand:          brand,
			Locale:         locale,
			Provenance:     provenance,
			ServingDesc:    r.ServingDesc,
			ServingGrams:   r.ServingGrams,
			ServingUnits:   encodeServingUnits(r.ServingUnits),
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
