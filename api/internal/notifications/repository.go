package notifications

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, n Notification) error {
	if err := r.db.WithContext(ctx).Create(&n).Error; err != nil {
		return fmt.Errorf("notifications: create: %w", err)
	}
	return nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID, limit int) ([]NotificationView, error) {
	out := []NotificationView{}
	err := r.db.WithContext(ctx).
		Table("notifications AS n").
		Select("n.id AS id, n.type AS type, n.actor_id AS actor_id, u.display_name AS actor_name, "+
			"n.entity_id AS entity_id, (n.read_at IS NOT NULL) AS read, n.created_at AS created_at").
		Joins("JOIN users u ON u.id = n.actor_id").
		Where("n.user_id = ?", userID).
		Order("n.created_at DESC").
		Limit(limit).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("notifications: list for user: %w", err)
	}
	return out, nil
}

func (r Repository) UnreadCount(ctx context.Context, userID uuid.UUID) (int, error) {
	var c int64
	if err := r.db.WithContext(ctx).Model(&Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Count(&c).Error; err != nil {
		return 0, fmt.Errorf("notifications: unread count: %w", err)
	}
	return int(c), nil
}

func (r Repository) MarkAllRead(ctx context.Context, userID uuid.UUID) (int, error) {
	res := r.db.WithContext(ctx).Model(&Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Update("read_at", gorm.Expr("now()"))
	if res.Error != nil {
		return 0, fmt.Errorf("notifications: mark all read: %w", res.Error)
	}
	return int(res.RowsAffected), nil
}
