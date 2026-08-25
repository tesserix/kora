package identity

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

type Repository struct{ db *gorm.DB }

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// FindByCanonical resolves a FOLDED handle to its owner. There is exactly one
// query shape in this package that reads by handle, and it is this one: an
// unfolded or prefix variant added later would quietly reopen enumeration.
func (r Repository) FindByCanonical(ctx context.Context, canonical string) (user.User, error) {
	var u user.User
	err := r.db.WithContext(ctx).
		Where("handle_canonical = ?", canonical).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return user.User{}, ErrNotFound
	}
	if err != nil {
		return user.User{}, fmt.Errorf("identity: find by handle: %w", err)
	}
	return u, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (user.User, error) {
	var u user.User
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return user.User{}, ErrNotFound
	}
	if err != nil {
		return user.User{}, fmt.Errorf("identity: find user: %w", err)
	}
	return u, nil
}

func (r Repository) IsRetired(ctx context.Context, canonical string) (bool, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Raw(`SELECT count(*) FROM retired_handles WHERE handle_canonical = ?`, canonical).
		Scan(&n).Error
	if err != nil {
		return false, fmt.Errorf("identity: check retired: %w", err)
	}
	return n > 0, nil
}

// SetHandle writes the new handle and retires the previous one in ONE
// transaction. Splitting them would leave a window where a crash between the
// two statements either loses the retirement (the old handle returns to the
// pool -- the impersonation this design exists to prevent) or retires a handle
// the user still holds.
//
// prevCanonical is "" when the user had no handle; nothing is retired then.
func (r Repository) SetHandle(ctx context.Context, id uuid.UUID, display, canonical, prevCanonical string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if prevCanonical != "" && prevCanonical != canonical {
			if err := tx.Exec(
				`INSERT INTO retired_handles (handle_canonical) VALUES (?)
				 ON CONFLICT (handle_canonical) DO NOTHING`, prevCanonical).Error; err != nil {
				return fmt.Errorf("identity: retire previous handle: %w", err)
			}
		}
		out := tx.Exec(
			`UPDATE users SET handle = ?, handle_canonical = ? WHERE id = ?`,
			display, canonical, id)
		if out.Error != nil {
			return out.Error
		}
		if out.RowsAffected == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// ClearHandle drops the user's handle and retires it, in one transaction, for
// the same reason SetHandle does.
func (r Repository) ClearHandle(ctx context.Context, id uuid.UUID, prevCanonical string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if prevCanonical != "" {
			if err := tx.Exec(
				`INSERT INTO retired_handles (handle_canonical) VALUES (?)
				 ON CONFLICT (handle_canonical) DO NOTHING`, prevCanonical).Error; err != nil {
				return fmt.Errorf("identity: retire handle on clear: %w", err)
			}
		}
		return tx.Exec(
			`UPDATE users SET handle = NULL, handle_canonical = NULL WHERE id = ?`, id).Error
	})
}
