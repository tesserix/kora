package groups

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

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) CreateGroup(ctx context.Context, ownerID uuid.UUID, name, code string) (Group, error) {
	g := Group{Name: name, OwnerID: ownerID, InviteCode: code}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&g).Error; err != nil {
			return err
		}
		return tx.Create(&GroupMember{GroupID: g.ID, UserID: ownerID, Role: RoleOwner}).Error
	})
	if err != nil {
		return Group{}, fmt.Errorf("groups: create: %w", err)
	}
	return g, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Group, error) {
	var g Group
	err := r.db.WithContext(ctx).First(&g, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("groups: find by id: %w", err)
	}
	return &g, nil
}

func (r Repository) FindByInviteCode(ctx context.Context, code string) (*Group, error) {
	var g Group
	err := r.db.WithContext(ctx).Where("invite_code = ?", code).First(&g).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("groups: find by code: %w", err)
	}
	return &g, nil
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]GroupSummary, error) {
	out := []GroupSummary{}
	err := r.db.WithContext(ctx).
		Table("groups AS g").
		Select("g.id AS id, g.name AS name, gm.role AS role, (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS member_count").
		Joins("JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?", userID).
		Order("g.created_at DESC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list for user: %w", err)
	}
	return out, nil
}

func (r Repository) AddMember(ctx context.Context, groupID, userID uuid.UUID, role Role) error {
	m := GroupMember{GroupID: groupID, UserID: userID, Role: role}
	// idempotent: do nothing if the (group,user) row already exists
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&m).Error
	if err != nil {
		return fmt.Errorf("groups: add member: %w", err)
	}
	return nil
}

func (r Repository) RemoveMember(ctx context.Context, groupID, userID uuid.UUID) error {
	if err := r.db.WithContext(ctx).
		Where("group_id = ? AND user_id = ?", groupID, userID).
		Delete(&GroupMember{}).Error; err != nil {
		return fmt.Errorf("groups: remove member: %w", err)
	}
	return nil
}

func (r Repository) IsMember(ctx context.Context, groupID, userID uuid.UUID) (bool, error) {
	var count int64
	if err := r.db.WithContext(ctx).Model(&GroupMember{}).
		Where("group_id = ? AND user_id = ?", groupID, userID).
		Count(&count).Error; err != nil {
		return false, fmt.Errorf("groups: is member: %w", err)
	}
	return count > 0, nil
}

func (r Repository) RoleOf(ctx context.Context, groupID, userID uuid.UUID) (Role, bool, error) {
	var m GroupMember
	err := r.db.WithContext(ctx).
		Where("group_id = ? AND user_id = ?", groupID, userID).First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("groups: role of: %w", err)
	}
	return m.Role, true, nil
}

func (r Repository) ListMembers(ctx context.Context, groupID uuid.UUID) ([]MemberView, error) {
	out := []MemberView{}
	err := r.db.WithContext(ctx).
		Table("group_members AS gm").
		Select("u.id AS id, u.display_name AS display_name, gm.role AS role").
		Joins("JOIN users u ON u.id = gm.user_id").
		Where("gm.group_id = ?", groupID).
		Order("gm.role ASC, u.display_name ASC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list members: %w", err)
	}
	return out, nil
}

func (r Repository) ListMembersForProgress(ctx context.Context, groupID uuid.UUID) ([]MemberProgressRow, error) {
	out := []MemberProgressRow{}
	err := r.db.WithContext(ctx).
		Table("group_members AS gm").
		Select("u.id AS id, u.display_name AS display_name, u.share_progress AS share_progress, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = gm.user_id").
		Where("gm.group_id = ?", groupID).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("groups: list members for progress: %w", err)
	}
	return out, nil
}

func (r Repository) Rename(ctx context.Context, groupID uuid.UUID, name string) error {
	if err := r.db.WithContext(ctx).Model(&Group{}).Where("id = ?", groupID).
		Updates(map[string]any{"name": name, "updated_at": gorm.Expr("now()")}).Error; err != nil {
		return fmt.Errorf("groups: rename: %w", err)
	}
	return nil
}

func (r Repository) DeleteGroup(ctx context.Context, groupID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Group{}, "id = ?", groupID).Error; err != nil {
		return fmt.Errorf("groups: delete: %w", err)
	}
	return nil
}
