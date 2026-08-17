// Package nutrition owns canonical food records and their lookup.
package nutrition

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Provenance = string

const (
	ProvenanceAFCD Provenance = "afcd"
	// ProvenanceIFCT marks the Indian Food Composition Tables (IFCT 2017) — the
	// Indian generic reference set, the counterpart to AFCD's Australian one.
	// Like AFCD it is per-100 g lab data with no serving size and no brand, so
	// every row types as `generic`. See scripts/ifct_convert.py, which converts
	// IFCT's kilojoules to kcal and gates each row on Atwater.
	ProvenanceIFCT         Provenance = "ifct"
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

// Locale is which food culture a row describes — the answer to "is this food
// from here?", which neither Provenance (which dataset) nor EntityType (what
// kind of thing) can give.
//
// It exists because USDA is 7,740 rows against AFCD's 1,635 and IFCT's 523, so
// on an India + Australia user base the US meaning of "chips", "biscuit",
// "capsicum" and "rocket" outnumbers the local one on every query. Locale fixes
// that as a class rather than term by term (kora#212 Phase 4).
type Locale = string

const (
	LocaleAU Locale = "AU"
	LocaleIN Locale = "IN"
	LocaleUS Locale = "US"
	// LocaleUnknown is a real state, not a gap: the row gets no locale
	// preference in either direction. Correct for user estimates and for any
	// source that is not national reference data.
	LocaleUnknown Locale = ""
)

// DeriveLocale states the provenance→locale rule in one place, so a new ingest
// stays correct without maintenance.
//
// `curated` is deliberately absent: au_in_dishes.json is MIXED (46 Indian
// dishes, 15 Australian), so deriving it from provenance would confidently
// mislabel two thirds of the file. Those rows carry an explicit per-row locale
// from the source JSON instead, and this returns unknown for them so a caller
// that forgets to pass one gets no preference rather than a wrong one.
func DeriveLocale(provenance Provenance) Locale {
	switch provenance {
	case ProvenanceAFCD, ProvenanceOFF:
		// OFF is Australian here specifically because off_au.json is filtered
		// to Australian products at conversion time. If a second OFF region is
		// ever ingested, this rule stops being true and must move to the
		// converter, like curated's did.
		return LocaleAU
	case ProvenanceIFCT:
		return LocaleIN
	case ProvenanceUSDA:
		return LocaleUS
	default:
		return LocaleUnknown
	}
}

// EntityType is what KIND of thing a food row is, as distinct from Provenance,
// which is where it came from. Provenance answers a question about lineage and
// trust; EntityType answers whether the row describes one specific packaged
// item or a food in general. See migration 000033 for the full rationale,
// including why there is no 'dish' value yet.
type EntityType = string

const (
	// EntityTypeGeneric is a reference figure for a food itself, not for any
	// one seller's version of it: USDA and AFCD reference data, hand-authored
	// dishes, and user estimates.
	EntityTypeGeneric EntityType = "generic"
	// EntityTypeBrandedProduct is one specific packaged retail item.
	EntityTypeBrandedProduct EntityType = "branded_product"
)

// DeriveEntityType states the rule in one place: a row is a branded_product
// when it identifies one specific packaged item — it carries a barcode or a
// non-empty brand — and generic otherwise.
//
// The barcode half is load-bearing rather than belt-and-braces: 80 rows in the
// live index come from OpenFoodFacts with a real barcode and an empty brand
// ("Gala Apple", "wafer crackers"). They are retail products whose brand field
// OFF left blank, and a brand-only rule would call every one of them generic
// reference data.
//
// Deliberately reads only the row's own identity columns and not Provenance, so
// a label_ocr row — scanned off a package, so barcoded but possibly with no
// brand string — types itself correctly without a rule change.
func DeriveEntityType(brand string, barcode *string) EntityType {
	if barcode != nil && strings.TrimSpace(*barcode) != "" {
		return EntityTypeBrandedProduct
	}
	if strings.TrimSpace(brand) != "" {
		return EntityTypeBrandedProduct
	}
	return EntityTypeGeneric
}

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
	ID             uuid.UUID `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name           string    `json:"name"`
	Brand          string    `json:"brand"`
	NormalizedName string    `gorm:"column:normalized_name" json:"-"`
	Provenance     string    `json:"provenance"`
	// EntityType is json:"-" on purpose. Phase 1 of kora#212 is data-model
	// only: nothing scores, ranks, filters or renders on it yet, and putting it
	// in the API response would be a behaviour change ahead of a consumer.
	EntityType EntityType `gorm:"column:entity_type" json:"-"`
	// Locale is json:"-" for the same reason as EntityType: it is a ranking
	// input, not something a client renders or should start depending on.
	Locale         Locale          `gorm:"column:locale" json:"-"`
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

// BeforeCreate types any row that reaches the database without an EntityType.
//
// The two production insert paths (Repository.Insert and admin's CreateFood)
// both set it explicitly, so in normal operation this is a no-op. It exists
// because "set it at ingest" is only true for the ingest paths that exist
// today: a future caller that builds a FoodItem and calls Create directly would
// otherwise fall through to the column DEFAULT and silently land in `generic`
// even when it is plainly a barcoded retail product. Applying the same rule
// here makes the invariant a property of the model rather than of a checklist.
func (f *FoodItem) BeforeCreate(*gorm.DB) error {
	if f.EntityType == "" {
		f.EntityType = DeriveEntityType(f.Brand, f.Barcode)
	}
	return nil
}
