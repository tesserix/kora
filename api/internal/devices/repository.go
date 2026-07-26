package devices

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Upsert stores a token for a user, reassigning it if the same physical token
// was previously bound to a different account (shared/reset device).
func (r Repository) Upsert(ctx context.Context, userID uuid.UUID, token, platform string) error {
	dt := DeviceToken{UserID: userID, Token: token, Platform: platform}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "token"}},
			DoUpdates: clause.Assignments(map[string]any{
				"user_id":    userID,
				"platform":   platform,
				"updated_at": gorm.Expr("now()"),
			}),
		}).
		Create(&dt).Error
	if err != nil {
		return fmt.Errorf("devices: upsert: %w", err)
	}
	return nil
}

// DeleteByToken removes a token binding only if it belongs to userID (the
// caller may only unregister their own device).
func (r Repository) DeleteByToken(ctx context.Context, userID uuid.UUID, token string) error {
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND token = ?", userID, token).
		Delete(&DeviceToken{}).Error; err != nil {
		return fmt.Errorf("devices: delete by token: %w", err)
	}
	return nil
}

// DeleteToken prunes a token regardless of owner (used when Expo reports it as
// DeviceNotRegistered).
func (r Repository) DeleteToken(ctx context.Context, token string) error {
	if err := r.db.WithContext(ctx).
		Where("token = ?", token).
		Delete(&DeviceToken{}).Error; err != nil {
		return fmt.Errorf("devices: delete token: %w", err)
	}
	return nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]DeviceToken, error) {
	out := []DeviceToken{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("devices: list for user: %w", err)
	}
	return out, nil
}
