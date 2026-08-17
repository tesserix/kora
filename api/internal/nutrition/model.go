// Package nutrition owns canonical food records and their lookup.
package nutrition

import (
	"encoding/json"
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
	// ProvenanceCurated marks hand-authored entries — dishes no public dataset
	// covers (USDA SR Legacy returns zero hits for dal, dosa, paneer, idli,
	// samosa, vegemite, weet-bix, lamington). Values are considered estimates
	// for a home-cooked portion, not lab measurements.
	ProvenanceCurated Provenance = "curated"
)

const (
	// MatchPersonalAlias is an alias THIS user saved themselves — a correction
	// they made once and expect to stick. It is split out from MatchAlias
	// because the two carry very different authority despite both scoring 1.0:
	// a personal alias is the user's own answer coming back, while a global
	// alias is curated data that happens to match the string identify produced.
	// Downstream (see ai/reduction.go) only the personal one is exempt from
	// phrase-reduction damping; exempting both would reopen kora#184, where a
	// global alias for "chicken" auto-logged an unrelated row.
	MatchPersonalAlias = "personal_alias"
	MatchAlias         = "alias"
	MatchFullText      = "full_text"
	MatchEmbedding     = "embedding"
)

// Candidate is a ranked resolution result. MatchScore is normalized 0..1.
type Candidate struct {
	Item       FoodItem `json:"item"`
	MatchScore float64  `json:"match_score"`
	MatchTier  string   `json:"match_tier"`
}

type FoodItem struct {
	ID             uuid.UUID       `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name           string          `json:"name"`
	Brand          string          `json:"brand"`
	NormalizedName string          `gorm:"column:normalized_name" json:"-"`
	Provenance     string          `json:"provenance"`
	Barcode        *string         `json:"barcode,omitempty"`
	ServingDesc    string          `json:"serving_desc"`
	ServingGrams   float64         `json:"serving_grams"`
	BaseUnit       string          `gorm:"column:base_unit;default:g" json:"base_unit"`
	ServingUnits   json.RawMessage `gorm:"column:serving_units;type:jsonb;default:'[]'" json:"serving_units,omitempty"`
	KcalPer100g    float64         `gorm:"column:kcal_per_100g" json:"kcal_per_100g"`
	ProteinPer100g float64         `gorm:"column:protein_per_100g" json:"protein_per_100g"`
	CarbsPer100g   float64         `gorm:"column:carbs_per_100g" json:"carbs_per_100g"`
	FatPer100g     float64         `gorm:"column:fat_per_100g" json:"fat_per_100g"`
	FiberPer100g   float64         `gorm:"column:fiber_per_100g" json:"fiber_per_100g"`
	CreatedAt      time.Time       `json:"created_at"`
}
