package social

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, f Friendship) (Friendship, error) {
	if err := r.db.WithContext(ctx).Create(&f).Error; err != nil {
		return Friendship{}, fmt.Errorf("social: create: %w", err)
	}
	return f, nil
}

// FindByPair returns the friendship between a and b in either direction, or
// (nil, nil) when none exists.
func (r Repository) FindByPair(ctx context.Context, a, b uuid.UUID) (*Friendship, error) {
	var f Friendship
	err := r.db.WithContext(ctx).
		Where("(requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)", a, b, b, a).
		First(&f).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("social: find pair: %w", err)
	}
	return &f, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Friendship, error) {
	var f Friendship
	err := r.db.WithContext(ctx).First(&f, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("social: find by id: %w", err)
	}
	return &f, nil
}

// ListAccepted returns the other party of every accepted friendship for userID.
func (r Repository) ListAccepted(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	views := []FriendView{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("u.id AS id, u.display_name AS display_name").
		Joins("JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END", userID).
		Where("f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)", FriendStatusAccepted, userID, userID).
		Order("u.display_name ASC").
		Scan(&views).Error
	if err != nil {
		return nil, fmt.Errorf("social: list accepted: %w", err)
	}
	return views, nil
}

// reqRow is a flat scan target; mapped into RequestView below.
type reqRow struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	DisplayName string
}

func (r Repository) listRequests(ctx context.Context, whereCol string, userID uuid.UUID, joinCol string) ([]RequestView, error) {
	rows := []reqRow{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("f.id AS id, u.id AS user_id, u.display_name AS display_name").
		Joins("JOIN users u ON u.id = f."+joinCol).
		Where("f.status = ? AND f."+whereCol+" = ?", FriendStatusPending, userID).
		Order("f.created_at DESC").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("social: list requests: %w", err)
	}
	out := make([]RequestView, 0, len(rows))
	for _, row := range rows {
		out = append(out, RequestView{ID: row.ID, User: FriendView{ID: row.UserID, DisplayName: row.DisplayName}})
	}
	return out, nil
}

// ListPending returns incoming (addressee=userID, other=requester) and
// outgoing (requester=userID, other=addressee) pending requests.
func (r Repository) ListPending(ctx context.Context, userID uuid.UUID) (incoming, outgoing []RequestView, err error) {
	incoming, err = r.listRequests(ctx, "addressee_id", userID, "requester_id")
	if err != nil {
		return nil, nil, err
	}
	outgoing, err = r.listRequests(ctx, "requester_id", userID, "addressee_id")
	if err != nil {
		return nil, nil, err
	}
	return incoming, outgoing, nil
}

func (r Repository) UpdateStatus(ctx context.Context, id uuid.UUID, status FriendStatus) error {
	if err := r.db.WithContext(ctx).Model(&Friendship{}).Where("id = ?", id).
		Updates(map[string]any{"status": status, "updated_at": gorm.Expr("now()")}).Error; err != nil {
		return fmt.Errorf("social: update status: %w", err)
	}
	return nil
}

func (r Repository) Delete(ctx context.Context, id uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Friendship{}, "id = ?", id).Error; err != nil {
		return fmt.Errorf("social: delete: %w", err)
	}
	return nil
}
