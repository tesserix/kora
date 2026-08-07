package user

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

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

// seedableDisplayName trims name and applies it only when it fits the same
// bound Handler.UpdateProfile enforces (MaxDisplayNameLen, handler.go). The
// real endpoint rejects an over-long name with a 400; EnsureUser runs as
// silent background provisioning with no request to fail, so it mirrors the
// *spirit* of that rejection by writing nothing rather than truncating a
// partial name. A blank (or whitespace-only) claim likewise seeds nothing.
func seedableDisplayName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > MaxDisplayNameLen {
		return ""
	}
	return trimmed
}

// EnsureUser resolves the user for firebaseUID, provisioning a new row via
// UpsertByFirebaseUID only when none exists yet. This lets non-/me endpoints
// safely resolve a user that has never hit /me, instead of 500ing.
//
// It also seeds display_name from name whenever the row's current
// display_name is empty -- both for a row just created here, and to repair a
// pre-existing row (e.g. a Google user provisioned before this claim was
// wired through) that still has ''. The presence check is `== ""`, not a
// nullness check: display_name is a nullable column, but every row ever
// written via UpsertByFirebaseUID/Create got the Go zero value '' rather
// than SQL NULL (see the identical trap documented on User.AppleRefreshToken
// in model.go), so 'IS NULL' would never match and the repair would be dead
// code. A non-empty display_name is never overwritten -- users can rename
// via SetDisplayName (used by Apple sign-in and manual rename), and a later
// Google sign-in must not clobber that choice.
func (r Repository) EnsureUser(ctx context.Context, firebaseUID, email, name string) (User, error) {
	var u User
	err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&u).Error
	switch {
	case err == nil:
		// existing row, fall through to the seeding check below
	case errors.Is(err, gorm.ErrRecordNotFound):
		u, err = r.UpsertByFirebaseUID(ctx, firebaseUID, email)
		if err != nil {
			return User{}, err
		}
	default:
		return User{}, fmt.Errorf("user: ensure lookup: %w", err)
	}

	if seed := seedableDisplayName(name); u.DisplayName == "" && seed != "" {
		if err := r.SetDisplayName(ctx, u.ID, seed); err != nil {
			// A failed seed write is not fatal: EnsureUser exists so
			// non-/me endpoints can resolve a user instead of 500ing, and
			// it sits on the hot path of nearly every authenticated
			// request. Taking down a user's entire API access because a
			// cosmetic display name couldn't be written is disproportionate
			// -- the seed is self-healing, since the next authenticated
			// request will simply retry it while display_name is still ''.
			slog.WarnContext(ctx, "user: seed display name failed", "err", err, "user_id", u.ID)
		} else {
			u.DisplayName = seed
		}
	}
	return u, nil
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

func (r Repository) SetShareProgress(ctx context.Context, id uuid.UUID, share bool) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("share_progress", share).Error; err != nil {
		return fmt.Errorf("user: set share progress: %w", err)
	}
	return nil
}

func (r Repository) SetDisplayName(ctx context.Context, id uuid.UUID, name string) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("display_name", name).Error; err != nil {
		return fmt.Errorf("user: set display name: %w", err)
	}
	return nil
}

func (r Repository) SetAppleRefreshToken(ctx context.Context, id uuid.UUID, token string) error {
	if err := r.db.WithContext(ctx).Model(&User{}).Where("id = ?", id).Update("apple_refresh_token", token).Error; err != nil {
		return fmt.Errorf("user: set apple refresh token: %w", err)
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
