package notifications

import (
	"context"
	"fmt"
	"time"

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

// PendingPush is a notification awaiting an OS push, with the actor's name
// joined for the push body.
type PendingPush struct {
	ID        uuid.UUID  `json:"id"`
	UserID    uuid.UUID  `json:"user_id"`
	Type      string     `json:"type"`
	ActorName string     `json:"actor_name"`
	EntityID  *uuid.UUID `json:"entity_id"`
}

// SkipStalePush marks unsent rows older than cutoff as sent without pushing
// them — the freshness guard against a stale-push stampede. Returns the count.
func (r Repository) SkipStalePush(ctx context.Context, cutoff time.Time) (int, error) {
	res := r.db.WithContext(ctx).Model(&Notification{}).
		Where("push_sent_at IS NULL AND created_at <= ?", cutoff).
		Update("push_sent_at", gorm.Expr("now()"))
	if res.Error != nil {
		return 0, fmt.Errorf("notifications: skip stale push: %w", res.Error)
	}
	return int(res.RowsAffected), nil
}

// ListPendingPush returns unsent rows newer than since (the freshness window),
// oldest first, with the actor display name joined in.
func (r Repository) ListPendingPush(ctx context.Context, since time.Time, limit int) ([]PendingPush, error) {
	out := []PendingPush{}
	err := r.db.WithContext(ctx).
		Table("notifications AS n").
		Select("n.id AS id, n.user_id AS user_id, n.type AS type, u.display_name AS actor_name, n.entity_id AS entity_id").
		Joins("JOIN users u ON u.id = n.actor_id").
		Where("n.push_sent_at IS NULL AND n.created_at > ?", since).
		Order("n.created_at ASC").
		Limit(limit).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("notifications: list pending push: %w", err)
	}
	return out, nil
}

func (r Repository) MarkPushSent(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Model(&Notification{}).
		Where("id = ?", id).
		Update("push_sent_at", gorm.Expr("now()")).Error; err != nil {
		return fmt.Errorf("notifications: mark push sent: %w", err)
	}
	return nil
}
