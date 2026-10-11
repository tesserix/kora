package tracking

import (
	"context"
	"fmt"
	"time"

	"github.com/tesserix/kora/api/internal/access"
)

// FriendBodyEntry is one weigh-in as ANOTHER PERSON is allowed to see it,
// under an access.CategoryBody grant (kora#438).
//
// It is deliberately NOT WeightEntry. That type embeds BodyComposition and
// carries id, created_at, hk_uuid and source; reusing it here would mean a
// field added to either struct later becomes visible cross-user silently,
// with no diff anywhere that looks like a permission change. The duplication
// is the point: this struct is the exposure boundary, readable in one place.
//
// What is left out, and why:
//
//   - id / created_at — a viewer cannot edit or reference another person's
//     entry, so the handle is of no use to them.
//   - hk_uuid — a HealthKit sample identifier. Internal plumbing that makes a
//     re-sync idempotent, and nobody else's business.
//   - source — how someone weighs themselves (manual, a scale screenshot,
//     Apple Health) is a fact about their habits rather than about their
//     body, and the grant is for the body.
//
// TestFriendBodyEntryExposesExactlyTheseFields pins the JSON key set, so
// widening this requires editing a test that explains the rule.
type FriendBodyEntry struct {
	LoggedAt  time.Time `json:"logged_at"`
	LocalDate time.Time `json:"local_date"`
	WeightKg  float64   `json:"weight_kg"`

	// Scale metrics. Pointers with omitempty throughout, exactly as on
	// BodyComposition: a nil reading must stay distinguishable from a
	// measured zero, and most entries carry only some of these.
	BodyFatPct         *float64 `json:"body_fat_pct,omitempty"`
	SubcutaneousFatPct *float64 `json:"subcutaneous_fat_pct,omitempty"`
	// VisceralFatRating is a vendor RATING, not a percentage. Never render it
	// with a % sign — see BodyComposition.
	VisceralFatRating *float64 `json:"visceral_fat_rating,omitempty"`
	SkeletalMusclePct *float64 `json:"skeletal_muscle_pct,omitempty"`
	MuscleMassKg      *float64 `json:"muscle_mass_kg,omitempty"`
	BodyWaterPct      *float64 `json:"body_water_pct,omitempty"`
	ProteinPct        *float64 `json:"protein_pct,omitempty"`
	BoneMassKg        *float64 `json:"bone_mass_kg,omitempty"`
	// ScaleBMRKcal is the scale's own BMR guess, kept for comparison only. It
	// must never feed a calorie target — least of all a viewer's.
	ScaleBMRKcal *float64 `json:"scale_bmr_kcal,omitempty"`

	// Tape measurements, in centimetres. The client converts for display.
	NeckCm  *float64 `json:"neck_cm,omitempty"`
	ChestCm *float64 `json:"chest_cm,omitempty"`
	WaistCm *float64 `json:"waist_cm,omitempty"`
	HipCm   *float64 `json:"hip_cm,omitempty"`
	ArmCm   *float64 `json:"arm_cm,omitempty"`
	ThighCm *float64 `json:"thigh_cm,omitempty"`
}

// friendBodyColumns is the allow-list, expressed as SQL. Selecting columns by
// name rather than `*` means a column added to weight_entries later is not
// returned to another person by default — it has to be added here, next to
// the doc comment above saying what belongs.
var friendBodyColumns = []string{
	"logged_at", "local_date", "weight_kg",
	"body_fat_pct", "subcutaneous_fat_pct", "visceral_fat_rating",
	"skeletal_muscle_pct", "muscle_mass_kg", "body_water_pct",
	"protein_pct", "bone_mass_kg", "scale_bmr_kcal",
	"neck_cm", "chest_cm", "waist_cm", "hip_cm", "arm_cm", "thigh_cm",
}

// BodySeriesFor returns the weigh-ins of the grant's OWNER within [from, to).
//
// It takes an access.Grant rather than an owner id on purpose: a bare UUID
// parameter here would let any caller hand over whichever id it happened to
// hold, and the grant would be decorative. grant.Owner() is the only key this
// query will accept. A forged access.Grant{} carries uuid.Nil and so matches
// no rows — the failure mode of circumventing the gateway is no data, never
// someone else's.
func (r Repository) BodySeriesFor(ctx context.Context, g access.Grant, from, to time.Time) ([]FriendBodyEntry, error) {
	entries := []FriendBodyEntry{}
	err := r.db.WithContext(ctx).
		Model(&WeightEntry{}).
		Select(friendBodyColumns).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", g.Owner(), from, to).
		Order("logged_at ASC").
		Scan(&entries).Error
	if err != nil {
		return nil, fmt.Errorf("tracking: friend body series: %w", err)
	}
	return entries, nil
}
