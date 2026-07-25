package user

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) UpsertByFirebaseUID(ctx context.Context, firebaseUID, email string) (User, error) {
	u := User{FirebaseUID: firebaseUID, Email: email, Timezone: DefaultTimezone}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "firebase_uid"}},
			DoUpdates: clause.AssignmentColumns([]string{"email", "updated_at"}),
		}).
		Create(&u).Error
	if err != nil {
		return User{}, fmt.Errorf("user: upsert: %w", err)
	}
	var out User
	if err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&out).Error; err != nil {
		return User{}, fmt.Errorf("user: fetch after upsert: %w", err)
	}
	return out, nil
}

// EnsureUser resolves the user for firebaseUID, provisioning a new row via
// UpsertByFirebaseUID only when none exists yet. This lets non-/me endpoints
// safely resolve a user that has never hit /me, instead of 500ing.
func (r Repository) EnsureUser(ctx context.Context, firebaseUID, email string) (User, error) {
	var u User
	err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&u).Error
	if err == nil {
		return u, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return User{}, fmt.Errorf("user: ensure lookup: %w", err)
	}
	return r.UpsertByFirebaseUID(ctx, firebaseUID, email)
}

func (r Repository) ByID(ctx context.Context, id uuid.UUID) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).First(&u, "id = ?", id).Error; err != nil {
		return User{}, fmt.Errorf("user: by id: %w", err)
	}
	return u, nil
}

func (r Repository) FindByEmail(ctx context.Context, email string) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).Where("email = ?", email).First(&u).Error; err != nil {
		return User{}, fmt.Errorf("user: by email: %w", err)
	}
	return u, nil
}

func (r Repository) FindByCode(ctx context.Context, code string) (User, error) {
	var u User
	if err := r.db.WithContext(ctx).Where("friend_code = ?", code).First(&u).Error; err != nil {
		return User{}, fmt.Errorf("user: by code: %w", err)
	}
	return u, nil
}

func (r Repository) SetFriendCode(ctx context.Context, id uuid.UUID, code string) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("friend_code", code).Error; err != nil {
		return fmt.Errorf("user: set friend code: %w", err)
	}
	return nil
}

func (r Repository) IDByFirebaseUID(ctx context.Context, firebaseUID string) (uuid.UUID, error) {
	var u User
	if err := r.db.WithContext(ctx).
		Select("id").
		Where("firebase_uid = ?", firebaseUID).
		First(&u).Error; err != nil {
		return uuid.Nil, fmt.Errorf("user: id by firebase uid: %w", err)
	}
	return u.ID, nil
}

// OnboardingFields mirrors onboarding.Input plus the computed onboarding.Targets.
type OnboardingFields struct {
	Sex            string
	BirthYear      int
	HeightCm       float64
	WeightKg       float64
	ActivityLevel  string
	Goal           string
	Timezone       string
	TargetKcal     float64
	TargetProteinG float64
	TargetCarbsG   float64
	TargetFatG     float64
}

func (r Repository) SaveOnboarding(ctx context.Context, userID uuid.UUID, f OnboardingFields) (User, error) {
	updates := map[string]any{
		"sex":              f.Sex,
		"birth_year":       f.BirthYear,
		"height_cm":        f.HeightCm,
		"weight_kg":        f.WeightKg,
		"activity_level":   f.ActivityLevel,
		"goal":             f.Goal,
		"timezone":         f.Timezone,
		"target_kcal":      f.TargetKcal,
		"target_protein_g": f.TargetProteinG,
		"target_carbs_g":   f.TargetCarbsG,
		"target_fat_g":     f.TargetFatG,
		"onboarded_at":     gorm.Expr("now()"),
	}
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", userID).Updates(updates).Error; err != nil {
		return User{}, fmt.Errorf("user: save onboarding: %w", err)
	}
	var out User
	if err := r.db.WithContext(ctx).First(&out, "id = ?", userID).Error; err != nil {
		return User{}, fmt.Errorf("user: fetch after onboarding: %w", err)
	}
	return out, nil
}
