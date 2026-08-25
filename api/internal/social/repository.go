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

// friendRow is the flat scan target for ListAccepted. AvatarPath is the raw
// object path -- ListAccepted returns it as-is; composing it into a URL is
// Service.ListFriends' job (it holds the avatarURL func, not the repository).
type friendRow struct {
	ID          uuid.UUID
	DisplayName string
	Handle      string
	AvatarPath  string
}

// ListAccepted returns the other party of every accepted friendship for userID.
// AvatarURL on the returned views holds the raw object PATH, not a composed
// URL -- callers must run it through an avatarURL func (see
// Service.ListFriends) before it reaches a client.
func (r Repository) ListAccepted(ctx context.Context, userID uuid.UUID) ([]FriendView, error) {
	rows := []friendRow{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("u.id AS id, u.display_name AS display_name, u.handle AS handle, u.avatar_path AS avatar_path").
		Joins("JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END", userID).
		Where("f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)", FriendStatusAccepted, userID, userID).
		Order("u.display_name ASC").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("social: list accepted: %w", err)
	}
	views := make([]FriendView, 0, len(rows))
	for _, row := range rows {
		views = append(views, FriendView{
			ID:          row.ID,
			DisplayName: row.DisplayName,
			Handle:      row.Handle,
			AvatarURL:   row.AvatarPath, // raw path; Service composes the URL
		})
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

// DeleteAndRevokeCircles deletes the friendship row AND, in the same
// transaction, drops both parties' share_circle_members rows in each
// other's circles.
//
// Circle membership is friendship-predicated at write time (share.Service
// only allows adding a friend), so it must not outlive the friendship: this
// is the only place that enforces that invariant. `social` reaching into
// share_circle_members by raw SQL instead of going through share.Repository
// is a deliberate, narrow coupling -- the alternative (access.Repository
// joining friendships on every progress/body read) would make the read path,
// which runs far more often than an unfriend, pay for a check that only
// matters at write time. Revocation belongs at the edge that breaks it.
func (r Repository) DeleteAndRevokeCircles(ctx context.Context, friendshipID, a, b uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&Friendship{}, "id = ?", friendshipID).Error; err != nil {
			return fmt.Errorf("social: delete: %w", err)
		}
		if err := tx.Exec(`
			DELETE FROM share_circle_members
			WHERE (member_user_id = ? AND circle_id IN (SELECT id FROM share_circles WHERE owner_id = ?))
			   OR (member_user_id = ? AND circle_id IN (SELECT id FROM share_circles WHERE owner_id = ?))
		`, b, a, a, b).Error; err != nil {
			return fmt.Errorf("social: revoke circle membership: %w", err)
		}
		return nil
	})
}

// AreFriends reports whether a and b have an accepted friendship.
func (r Repository) AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error) {
	f, err := r.FindByPair(ctx, a, b)
	if err != nil {
		return false, err
	}
	return f != nil && f.Status == FriendStatusAccepted, nil
}

// CompareRow is an accepted friend plus the fields needed to compute their
// metrics. Whether those metrics may be shown is decided by a resolved
// access.Grant, not by any field on this row (kora#326).
type CompareRow struct {
	ID          uuid.UUID
	DisplayName string
	TargetKcal  float64
}

func (r Repository) ListAcceptedForCompare(ctx context.Context, userID uuid.UUID) ([]CompareRow, error) {
	rows := []CompareRow{}
	err := r.db.WithContext(ctx).
		Table("friendships AS f").
		Select("u.id AS id, u.display_name AS display_name, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END", userID).
		Where("f.status = ? AND (f.requester_id = ? OR f.addressee_id = ?)", FriendStatusAccepted, userID, userID).
		Order("u.display_name ASC").
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("social: list accepted for compare: %w", err)
	}
	return rows, nil
}
