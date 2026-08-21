package tracking

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) AddWater(ctx context.Context, userID uuid.UUID, volumeML int, at time.Time, localDate time.Time) (WaterEntry, error) {
	if volumeML <= 0 {
		return WaterEntry{}, httpx.ValidationError{Message: "volume_ml must be positive"}
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WaterEntry{UserID: userID, VolumeML: volumeML, LoggedAt: at, LocalDate: localDate}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WaterEntry{}, fmt.Errorf("tracking: add water: %w", err)
	}
	return e, nil
}

// WaterTotalForDay sums the entries whose stored local_date is `day` — the
// day fixed at capture, not one re-derived from the current profile zone.
// See kora#84.
func (r Repository) WaterTotalForDay(ctx context.Context, userID uuid.UUID, day time.Time) (int, error) {
	var total *int
	err := r.db.WithContext(ctx).Model(&WaterEntry{}).
		Where("user_id = ? AND local_date = ?", userID, day.Format("2006-01-02")).
		Select("COALESCE(SUM(volume_ml), 0)").Scan(&total).Error
	if err != nil {
		return 0, fmt.Errorf("tracking: water total: %w", err)
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}

// WeightInput is what a caller wants recorded. It is a struct rather than a
// widened positional signature because #45 alone takes AddWeight from four
// arguments to thirteen, most of them *float64 — a call site of bare pointers
// in a fixed order is a transposition waiting to happen, and #314's screenshot
// reader will add more.
type WeightInput struct {
	WeightKg  float64
	LoggedAt  time.Time
	LocalDate time.Time
	// Composition is optional. A zero value records weight alone, with every
	// metric absent (not zero) and Source defaulting to manual.
	Composition BodyComposition
}

// AddWeight records a weight-only entry.
//
// Kept as-is so existing callers compile unchanged; it delegates to
// AddWeightEntry, which is the one to use when there is composition data.
func (r Repository) AddWeight(ctx context.Context, userID uuid.UUID, weightKg float64, at time.Time, localDate time.Time) (WeightEntry, error) {
	return r.AddWeightEntry(ctx, userID, WeightInput{WeightKg: weightKg, LoggedAt: at, LocalDate: localDate})
}

// AddWeightEntry records a weight with optional body composition (kora#45).
//
// Out-of-range metrics are REJECTED rather than clamped or dropped. A stored
// impossible value looks like data forever and quietly deforms every chart
// drawn from it; a rejected write is visible at the moment the mistake is made.
func (r Repository) AddWeightEntry(ctx context.Context, userID uuid.UUID, in WeightInput) (WeightEntry, error) {
	if in.WeightKg <= 0 {
		return WeightEntry{}, httpx.ValidationError{Message: "weight_kg must be positive"}
	}
	comp, err := validateComposition(in.Composition)
	if err != nil {
		return WeightEntry{}, err
	}
	at := in.LoggedAt
	if at.IsZero() {
		at = time.Now()
	}
	e := WeightEntry{
		UserID:          userID,
		WeightKg:        in.WeightKg,
		LoggedAt:        at,
		LocalDate:       in.LocalDate,
		BodyComposition: comp,
	}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WeightEntry{}, fmt.Errorf("tracking: add weight: %w", err)
	}
	return e, nil
}

// maxVisceralFatRating bounds the widest vendor scale in use (Tanita's 1-59),
// so a percentage mistakenly written into the rating field is caught whenever
// it exceeds 59 rather than being stored as a plausible-looking rating.
const maxVisceralFatRating = 59

// validateComposition returns a copy with Source defaulted, rejecting values
// that cannot be true. It never mutates its argument.
func validateComposition(c BodyComposition) (BodyComposition, error) {
	pcts := map[string]*float64{
		"body_fat_pct":         c.BodyFatPct,
		"subcutaneous_fat_pct": c.SubcutaneousFatPct,
		"skeletal_muscle_pct":  c.SkeletalMusclePct,
		"body_water_pct":       c.BodyWaterPct,
		"protein_pct":          c.ProteinPct,
	}
	for name, v := range pcts {
		if v != nil && (*v < 0 || *v > 100) {
			return BodyComposition{}, httpx.ValidationError{Message: name + " must be between 0 and 100"}
		}
	}
	masses := map[string]*float64{
		"muscle_mass_kg": c.MuscleMassKg,
		"bone_mass_kg":   c.BoneMassKg,
		"scale_bmr_kcal": c.ScaleBMRKcal,
	}
	for name, v := range masses {
		if v != nil && *v <= 0 {
			return BodyComposition{}, httpx.ValidationError{Message: name + " must be positive"}
		}
	}
	if c.VisceralFatRating != nil && (*c.VisceralFatRating <= 0 || *c.VisceralFatRating > maxVisceralFatRating) {
		return BodyComposition{}, httpx.ValidationError{
			Message: fmt.Sprintf("visceral_fat_rating must be between 0 and %d", maxVisceralFatRating),
		}
	}

	out := c
	if out.Source == "" {
		out.Source = SourceManual
	}
	if !out.Source.valid() {
		// Mirrors weight_entries_source_check. Caught here so the caller gets a
		// 400 naming the field instead of a 500 from a constraint violation.
		return BodyComposition{}, httpx.ValidationError{Message: "source is not a recognised instrument"}
	}
	return out, nil
}

func (r Repository) WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]WeightEntry, error) {
	entries := []WeightEntry{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, from, to).
		Order("logged_at ASC").
		Find(&entries).Error
	if err != nil {
		return nil, fmt.Errorf("tracking: weight series: %w", err)
	}
	return entries, nil
}
