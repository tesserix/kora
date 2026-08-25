package access

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

// GrantedOwners returns the subset of `owners` that have granted `category` to
// a circle containing `viewer`.
//
// One query for the whole list, never one per owner: both cross-user endpoints
// fan out over every friend or group member, and a per-owner resolve would be
// an N+1 on the hot path.
func (r Repository) GrantedOwners(ctx context.Context, viewer uuid.UUID, owners []uuid.UUID, category Category) ([]uuid.UUID, error) {
	if len(owners) == 0 {
		return nil, nil
	}
	out := []uuid.UUID{}
	err := r.db.WithContext(ctx).
		Table("share_circles AS c").
		// DISTINCT because two circles may both grant the same category to the
		// same viewer; that is one permission, not two.
		Distinct("c.owner_id").
		Joins("JOIN share_circle_members m ON m.circle_id = c.id").
		Joins("JOIN share_grants g ON g.circle_id = c.id").
		Where("m.member_user_id = ? AND g.category = ? AND c.owner_id IN ?", viewer, string(category), owners).
		Pluck("c.owner_id", &out).Error
	if err != nil {
		return nil, fmt.Errorf("access: granted owners: %w", err)
	}
	return out, nil
}
