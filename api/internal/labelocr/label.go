// Package labelocr reads packaged-food nutrition labels through Document Intelligence.
package labelocr

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

const (
	BasisPer100g  = "per_100g"
	BasisPer100ml = "per_100ml"

	IssueDerivedFromServing = "derived_from_serving"
	IssueOutOfRange         = "out_of_range"
	IssueLowConfidence      = "low_confidence"
	IssueAtwaterMismatch    = "energy_atwater_mismatch"

	kjPerKcal     = 4.184
	minConfidence = 0.6
)

// ErrUnreadable means the label gave nothing Kora could log.
var ErrUnreadable = errors.New("nutrition label unreadable")

// Field is one extracted value as returned by the kora.nutrition_label schema.
type Field struct {
	Value      json.RawMessage   `json:"value"`
	Evidence   []json.RawMessage `json:"evidence,omitempty"`
	Confidence float64           `json:"confidence"`
}

// Failure is a schema validation failure reported by Document Intelligence.
type Failure struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
}

type Nutrients struct {
	EnergyKcal    *float64 `json:"energy_kcal,omitempty"`
	ProteinG      *float64 `json:"protein_g,omitempty"`
	FatG          *float64 `json:"fat_g,omitempty"`
	SaturatedFatG *float64 `json:"saturated_fat_g,omitempty"`
	CarbohydrateG *float64 `json:"carbohydrate_g,omitempty"`
	SugarsG       *float64 `json:"sugars_g,omitempty"`
	FibreG        *float64 `json:"fibre_g,omitempty"`
	SodiumMg      *float64 `json:"sodium_mg,omitempty"`
}

// Label is a checked read; values are never corrected, only flagged.
type Label struct {
	Basis        string    `json:"basis"`
	Per100       Nutrients `json:"per_100"`
	PerServing   Nutrients `json:"per_serving"`
	ServingGrams *float64  `json:"serving_grams,omitempty"`
	Barcode      string    `json:"barcode,omitempty"`
	Issues       []string  `json:"issues"`
	NeedsReview  bool      `json:"needs_review"`
}

type quantity struct {
	Amount float64 `json:"amount"`
	Unit   string  `json:"unit"`
}

// Check turns extracted fields into a Label, deriving per-100 values from a
// mass-based serving only when the panel has no per-100 column.
func Check(fields map[string]Field, failures []Failure) (Label, error) {
	label := Label{Issues: []string{}}
	for _, failure := range failures {
		if failure.Severity == "error" {
			return Label{}, ErrUnreadable
		}
		label.addIssue(failure.Code)
	}

	var serving quantity
	decode(fields, "serving_size", &serving)
	decode(fields, "barcode", &label.Barcode)
	if serving.Unit == "g" && serving.Amount > 0 {
		label.ServingGrams = &serving.Amount
	}
	label.PerServing = column(fields, "per_serving")

	switch {
	case hasColumn(fields, BasisPer100g):
		label.Basis, label.Per100 = BasisPer100g, column(fields, BasisPer100g)
	case hasColumn(fields, BasisPer100ml):
		label.Basis, label.Per100 = BasisPer100ml, column(fields, BasisPer100ml)
	case serving.Amount > 0 && (serving.Unit == "g" || serving.Unit == "ml"):
		label.Basis = map[string]string{"g": BasisPer100g, "ml": BasisPer100ml}[serving.Unit]
		label.Per100 = label.PerServing.scaled(100 / serving.Amount)
		label.addIssue(IssueDerivedFromServing)
	}
	if label.Per100.EnergyKcal == nil || label.Per100.hasNonFinite() {
		return Label{}, ErrUnreadable
	}

	if label.Per100.outOfRange() {
		label.addIssue(IssueOutOfRange)
	}
	if label.Per100.atwaterMismatch() || label.PerServing.atwaterMismatch() {
		label.addIssue(IssueAtwaterMismatch)
	}
	for _, field := range fields {
		if field.Confidence < minConfidence {
			label.addIssue(IssueLowConfidence)
			break
		}
	}
	label.NeedsReview = len(label.Issues) > 0
	return label, nil
}

func (l *Label) addIssue(code string) {
	for _, existing := range l.Issues {
		if existing == code {
			return
		}
	}
	l.Issues = append(l.Issues, code)
}

func hasColumn(fields map[string]Field, name string) bool {
	for key := range fields {
		if strings.HasPrefix(key, name+".") {
			return true
		}
	}
	return false
}

func column(fields map[string]Field, name string) Nutrients {
	n := Nutrients{
		EnergyKcal:    number(fields, name+".energy_kcal"),
		ProteinG:      number(fields, name+".protein_g"),
		FatG:          number(fields, name+".fat_g"),
		SaturatedFatG: number(fields, name+".saturated_fat_g"),
		CarbohydrateG: number(fields, name+".carbohydrate_g"),
		SugarsG:       number(fields, name+".sugars_g"),
		FibreG:        number(fields, name+".fibre_g"),
		SodiumMg:      number(fields, name+".sodium_mg"),
	}
	if n.EnergyKcal == nil {
		if kj := number(fields, name+".energy_kj"); kj != nil {
			kcal := *kj / kjPerKcal
			n.EnergyKcal = &kcal
		}
	}
	return n
}

func (n Nutrients) scaled(factor float64) Nutrients {
	scale := func(v *float64) *float64 {
		if v == nil {
			return nil
		}
		out := *v * factor
		return &out
	}
	return Nutrients{
		EnergyKcal: scale(n.EnergyKcal), ProteinG: scale(n.ProteinG), FatG: scale(n.FatG),
		SaturatedFatG: scale(n.SaturatedFatG), CarbohydrateG: scale(n.CarbohydrateG),
		SugarsG: scale(n.SugarsG), FibreG: scale(n.FibreG), SodiumMg: scale(n.SodiumMg),
	}
}

// outOfRange catches physically impossible per-100 values; pure fat is ~900 kcal
// and table salt is ~39% sodium.
func (n Nutrients) outOfRange() bool {
	over := func(v *float64, limit float64) bool { return v != nil && (*v < 0 || *v > limit) }
	return over(n.EnergyKcal, 900) || over(n.SodiumMg, 40000) ||
		over(n.ProteinG, 100) || over(n.FatG, 100) || over(n.SaturatedFatG, 100) ||
		over(n.CarbohydrateG, 100) || over(n.SugarsG, 100) || over(n.FibreG, 100)
}

func (n Nutrients) hasNonFinite() bool {
	for _, value := range []*float64{n.EnergyKcal, n.ProteinG, n.FatG, n.SaturatedFatG, n.CarbohydrateG, n.SugarsG, n.FibreG, n.SodiumMg} {
		if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0)) {
			return true
		}
	}
	return false
}

func (n Nutrients) atwaterMismatch() bool {
	if n.EnergyKcal == nil || n.ProteinG == nil || n.CarbohydrateG == nil || n.FatG == nil {
		return false
	}
	expected := 4**n.ProteinG + 4**n.CarbohydrateG + 9**n.FatG
	// Match the nutrition-label schema's allowance for rounding and unlisted energy sources.
	return math.Abs(expected-*n.EnergyKcal) > math.Max(0.2**n.EnergyKcal, 15)
}

func number(fields map[string]Field, name string) *float64 {
	var v *float64
	if !decode(fields, name, &v) {
		return nil
	}
	return v
}

func decode(fields map[string]Field, name string, into any) bool {
	field, ok := fields[name]
	return ok && json.Unmarshal(field.Value, into) == nil
}
