// Package nutrition owns canonical food records and their lookup.
package nutrition

import (
	"time"

	"github.com/google/uuid"
)

type Provenance = string

const (
	ProvenanceAFCD         Provenance = "afcd"
	ProvenanceOFF          Provenance = "off"
	ProvenanceUSDA         Provenance = "usda"
	ProvenanceLabelOCR     Provenance = "label_ocr"
	ProvenanceUserEstimate Provenance = "user_estimate"
)

type FoodItem struct {
	ID             uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name           string    `json:"name"`
	Brand          string    `json:"brand"`
	Provenance     string    `json:"provenance"`
	Barcode        *string   `json:"barcode,omitempty"`
	ServingDesc    string    `json:"serving_desc"`
	ServingGrams   float64   `json:"serving_grams"`
	KcalPer100g    float64   `gorm:"column:kcal_per_100g" json:"kcal_per_100g"`
	ProteinPer100g float64   `gorm:"column:protein_per_100g" json:"protein_per_100g"`
	CarbsPer100g   float64   `gorm:"column:carbs_per_100g" json:"carbs_per_100g"`
	FatPer100g     float64   `gorm:"column:fat_per_100g" json:"fat_per_100g"`
	FiberPer100g   float64   `gorm:"column:fiber_per_100g" json:"fiber_per_100g"`
	CreatedAt      time.Time `json:"created_at"`
}
