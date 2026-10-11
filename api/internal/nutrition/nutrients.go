package nutrition

import (
	"fmt"
	"math"
)

// Nutrients holds optional measurements per 100 g; nil means unknown.
// RE and RAE, and vitamin D and D equivalents, retain their source definitions.
type Nutrients struct {
	SugarPer100g                 *float64 `gorm:"column:sugar_per_100g" json:"sugar_per_100g,omitempty"`
	SaturatedFatPer100g          *float64 `gorm:"column:saturated_fat_per_100g" json:"saturated_fat_per_100g,omitempty"`
	CholesterolMgPer100g         *float64 `gorm:"column:cholesterol_mg_per_100g" json:"cholesterol_mg_per_100g,omitempty"`
	SodiumMgPer100g              *float64 `gorm:"column:sodium_mg_per_100g" json:"sodium_mg_per_100g,omitempty"`
	CalciumMgPer100g             *float64 `gorm:"column:calcium_mg_per_100g" json:"calcium_mg_per_100g,omitempty"`
	IronMgPer100g                *float64 `gorm:"column:iron_mg_per_100g" json:"iron_mg_per_100g,omitempty"`
	PotassiumMgPer100g           *float64 `gorm:"column:potassium_mg_per_100g" json:"potassium_mg_per_100g,omitempty"`
	MagnesiumMgPer100g           *float64 `gorm:"column:magnesium_mg_per_100g" json:"magnesium_mg_per_100g,omitempty"`
	PhosphorusMgPer100g          *float64 `gorm:"column:phosphorus_mg_per_100g" json:"phosphorus_mg_per_100g,omitempty"`
	ZincMgPer100g                *float64 `gorm:"column:zinc_mg_per_100g" json:"zinc_mg_per_100g,omitempty"`
	SeleniumUgPer100g            *float64 `gorm:"column:selenium_ug_per_100g" json:"selenium_ug_per_100g,omitempty"`
	IodineUgPer100g              *float64 `gorm:"column:iodine_ug_per_100g" json:"iodine_ug_per_100g,omitempty"`
	VitaminARAEUgPer100g         *float64 `gorm:"column:vitamin_a_rae_ug_per_100g" json:"vitamin_a_rae_ug_per_100g,omitempty"`
	VitaminAREUgPer100g          *float64 `gorm:"column:vitamin_a_re_ug_per_100g" json:"vitamin_a_re_ug_per_100g,omitempty"`
	VitaminCMgPer100g            *float64 `gorm:"column:vitamin_c_mg_per_100g" json:"vitamin_c_mg_per_100g,omitempty"`
	VitaminDUgPer100g            *float64 `gorm:"column:vitamin_d_ug_per_100g" json:"vitamin_d_ug_per_100g,omitempty"`
	VitaminDEquivalentsUgPer100g *float64 `gorm:"column:vitamin_d_equivalents_ug_per_100g" json:"vitamin_d_equivalents_ug_per_100g,omitempty"`
	VitaminEMgPer100g            *float64 `gorm:"column:vitamin_e_mg_per_100g" json:"vitamin_e_mg_per_100g,omitempty"`
	VitaminKUgPer100g            *float64 `gorm:"column:vitamin_k_ug_per_100g" json:"vitamin_k_ug_per_100g,omitempty"`
	ThiaminMgPer100g             *float64 `gorm:"column:thiamin_mg_per_100g" json:"thiamin_mg_per_100g,omitempty"`
	RiboflavinMgPer100g          *float64 `gorm:"column:riboflavin_mg_per_100g" json:"riboflavin_mg_per_100g,omitempty"`
	NiacinMgPer100g              *float64 `gorm:"column:niacin_mg_per_100g" json:"niacin_mg_per_100g,omitempty"`
	VitaminB6MgPer100g           *float64 `gorm:"column:vitamin_b6_mg_per_100g" json:"vitamin_b6_mg_per_100g,omitempty"`
	VitaminB12UgPer100g          *float64 `gorm:"column:vitamin_b12_ug_per_100g" json:"vitamin_b12_ug_per_100g,omitempty"`
	FolateUgPer100g              *float64 `gorm:"column:folate_ug_per_100g" json:"folate_ug_per_100g,omitempty"`
	FolateDFEUgPer100g           *float64 `gorm:"column:folate_dfe_ug_per_100g" json:"folate_dfe_ug_per_100g,omitempty"`
}

// Values returns the nutrient columns and their measurements.
func (n Nutrients) Values() map[string]*float64 {
	return map[string]*float64{
		"sugar_per_100g":                    n.SugarPer100g,
		"saturated_fat_per_100g":            n.SaturatedFatPer100g,
		"cholesterol_mg_per_100g":           n.CholesterolMgPer100g,
		"sodium_mg_per_100g":                n.SodiumMgPer100g,
		"calcium_mg_per_100g":               n.CalciumMgPer100g,
		"iron_mg_per_100g":                  n.IronMgPer100g,
		"potassium_mg_per_100g":             n.PotassiumMgPer100g,
		"magnesium_mg_per_100g":             n.MagnesiumMgPer100g,
		"phosphorus_mg_per_100g":            n.PhosphorusMgPer100g,
		"zinc_mg_per_100g":                  n.ZincMgPer100g,
		"selenium_ug_per_100g":              n.SeleniumUgPer100g,
		"iodine_ug_per_100g":                n.IodineUgPer100g,
		"vitamin_a_rae_ug_per_100g":         n.VitaminARAEUgPer100g,
		"vitamin_a_re_ug_per_100g":          n.VitaminAREUgPer100g,
		"vitamin_c_mg_per_100g":             n.VitaminCMgPer100g,
		"vitamin_d_ug_per_100g":             n.VitaminDUgPer100g,
		"vitamin_d_equivalents_ug_per_100g": n.VitaminDEquivalentsUgPer100g,
		"vitamin_e_mg_per_100g":             n.VitaminEMgPer100g,
		"vitamin_k_ug_per_100g":             n.VitaminKUgPer100g,
		"thiamin_mg_per_100g":               n.ThiaminMgPer100g,
		"riboflavin_mg_per_100g":            n.RiboflavinMgPer100g,
		"niacin_mg_per_100g":                n.NiacinMgPer100g,
		"vitamin_b6_mg_per_100g":            n.VitaminB6MgPer100g,
		"vitamin_b12_ug_per_100g":           n.VitaminB12UgPer100g,
		"folate_ug_per_100g":                n.FolateUgPer100g,
		"folate_dfe_ug_per_100g":            n.FolateDFEUgPer100g,
	}
}

// Validate rejects non-finite, negative and physically impossible measurements.
func (n Nutrients) Validate() error {
	for column, value := range n.Values() {
		if value == nil {
			continue
		}
		maxValue := 100000000.0
		switch column {
		case "sugar_per_100g", "saturated_fat_per_100g":
			maxValue = 100
		case "cholesterol_mg_per_100g":
			maxValue = 100000
		case "sodium_mg_per_100g":
			maxValue = 100000
		case "calcium_mg_per_100g":
			maxValue = 100000
		case "iron_mg_per_100g":
			maxValue = 100000
		case "potassium_mg_per_100g":
			maxValue = 100000
		case "magnesium_mg_per_100g":
			maxValue = 100000
		case "phosphorus_mg_per_100g":
			maxValue = 100000
		case "zinc_mg_per_100g":
			maxValue = 100000
		case "vitamin_c_mg_per_100g":
			maxValue = 100000
		case "vitamin_e_mg_per_100g":
			maxValue = 100000
		case "thiamin_mg_per_100g":
			maxValue = 100000
		case "riboflavin_mg_per_100g":
			maxValue = 100000
		case "niacin_mg_per_100g":
			maxValue = 100000
		case "vitamin_b6_mg_per_100g":
			maxValue = 100000
		}
		if math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > maxValue {
			return fmt.Errorf("invalid nutrient %s", column)
		}
	}
	return nil
}
