package feedback

import (
	"context"
	"fmt"

	"gorm.io/gorm"
)

// Repository persists feedback submissions.
type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Create stores one submission and returns it with its database-assigned id
// and timestamp.
//
// Status defaults to StatusOpen here rather than relying on the column's SQL
// default: GORM sends a string field's Go zero value ("") on insert, which
// would defeat the column default and store an empty status.
func (r Repository) Create(ctx context.Context, f Feedback) (Feedback, error) {
	if f.Status == "" {
		f.Status = StatusOpen
	}
	if err := r.db.WithContext(ctx).Create(&f).Error; err != nil {
		return Feedback{}, fmt.Errorf("feedback: create: %w", err)
	}
	return f, nil
}
