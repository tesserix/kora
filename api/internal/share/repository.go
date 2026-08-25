package share

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, ownerID uuid.UUID, name string) (Circle, error) {
	c := Circle{OwnerID: ownerID, Name: strings.TrimSpace(name)}
	err := r.db.WithContext(ctx).Create(&c).Error
	if err != nil {
		// 23505 is the unique violation from share_circles_owner_name. Mapped
		// to a typed error so the handler can say "you already have a circle
		// called that" instead of a 500.
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return Circle{}, ErrDuplicateName
		}
		return Circle{}, fmt.Errorf("share: create circle: %w", err)
	}
	return c, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Circle, error) {
	var c Circle
	err := r.db.WithContext(ctx).First(&c, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("share: find circle: %w", err)
	}
	return &c, nil
}

func (r Repository) ListForOwner(ctx context.Context, ownerID uuid.UUID) ([]CircleView, error) {
	circles := []Circle{}
	if err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("created_at").
		Find(&circles).Error; err != nil {
		return nil, fmt.Errorf("share: list circles: %w", err)
	}

	views := make([]CircleView, 0, len(circles))
	for _, c := range circles {
		members := []MemberView{}
		if err := r.db.WithContext(ctx).
			Table("share_circle_members AS m").
			Select("u.id AS id, u.display_name AS display_name").
			Joins("JOIN users u ON u.id = m.member_user_id").
			Where("m.circle_id = ?", c.ID).
			Order("u.display_name").
			Scan(&members).Error; err != nil {
			return nil, fmt.Errorf("share: list members: %w", err)
		}

		cats := []access.Category{}
		if err := r.db.WithContext(ctx).
			Table("share_grants").
			Where("circle_id = ?", c.ID).
			Order("category").
			Pluck("category", &cats).Error; err != nil {
			return nil, fmt.Errorf("share: list grants: %w", err)
		}

		views = append(views, CircleView{ID: c.ID, Name: c.Name, Members: members, Categories: cats})
	}
	return views, nil
}

// AddMember is idempotent: adding someone already in the circle is a no-op, not
// an error, because the UI's "add" is a toggle and a double-tap is not a fault.
func (r Repository) AddMember(ctx context.Context, circleID, memberID uuid.UUID) error {
	err := r.db.WithContext(ctx).
		Exec(`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)
		      ON CONFLICT DO NOTHING`, circleID, memberID).Error
	if err != nil {
		return fmt.Errorf("share: add member: %w", err)
	}
	return nil
}

func (r Repository) RemoveMember(ctx context.Context, circleID, memberID uuid.UUID) error {
	err := r.db.WithContext(ctx).
		Exec(`DELETE FROM share_circle_members WHERE circle_id = ? AND member_user_id = ?`,
			circleID, memberID).Error
	if err != nil {
		return fmt.Errorf("share: remove member: %w", err)
	}
	return nil
}

// SetCategories REPLACES the circle's grants with exactly `cats`.
//
// Delete-then-insert inside one transaction, so revoking everything actually
// revokes -- an implementation that only inserts the new set would leave a
// revoked category granted, which is the worst direction for this bug to fail.
func (r Repository) SetCategories(ctx context.Context, circleID uuid.UUID, cats []access.Category) error {
	// Dedupe before inserting: (circle_id, category) is the share_grants
	// primary key, so a caller-supplied duplicate (e.g.
	// {"categories":["progress","progress"]}) would otherwise trip an
	// unmapped 23505 -> 500 instead of just collapsing harmlessly.
	seen := make(map[access.Category]struct{}, len(cats))
	deduped := make([]access.Category, 0, len(cats))
	for _, c := range cats {
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		deduped = append(deduped, c)
	}

	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`DELETE FROM share_grants WHERE circle_id = ?`, circleID).Error; err != nil {
			return fmt.Errorf("share: clear grants: %w", err)
		}
		for _, c := range deduped {
			if err := tx.Exec(`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`,
				circleID, string(c)).Error; err != nil {
				return fmt.Errorf("share: insert grant: %w", err)
			}
		}
		return nil
	})
}

func (r Repository) Delete(ctx context.Context, circleID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Circle{}, "id = ?", circleID).Error; err != nil {
		return fmt.Errorf("share: delete circle: %w", err)
	}
	return nil
}
