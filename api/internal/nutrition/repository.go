package nutrition

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

const searchLimitMax = 25

func (r Repository) Search(ctx context.Context, query string, limit int) ([]FoodItem, error) {
	if limit <= 0 || limit > searchLimitMax {
		limit = searchLimitMax
	}
	pattern := "%" + query + "%"
	var items []FoodItem
	err := r.db.WithContext(ctx).
		Where("name ILIKE ? OR brand ILIKE ?", pattern, pattern).
		Order("name ASC").
		Limit(limit).
		Find(&items).Error
	if err != nil {
		return nil, fmt.Errorf("nutrition: search: %w", err)
	}
	return items, nil
}

func (r Repository) GetByID(ctx context.Context, id uuid.UUID) (FoodItem, error) {
	var item FoodItem
	if err := r.db.WithContext(ctx).First(&item, "id = ?", id).Error; err != nil {
		return FoodItem{}, fmt.Errorf("nutrition: get by id: %w", err)
	}
	return item, nil
}

func (r Repository) Count(ctx context.Context) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&FoodItem{}).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("nutrition: count: %w", err)
	}
	return n, nil
}

// Insert adds items that are not already present (matched by name+brand).
func (r Repository) Insert(ctx context.Context, items []FoodItem) (int, error) {
	inserted := 0
	for _, item := range items {
		var count int64
		if err := r.db.WithContext(ctx).Model(&FoodItem{}).
			Where("name = ? AND brand = ?", item.Name, item.Brand).
			Count(&count).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert check: %w", err)
		}
		if count > 0 {
			continue
		}
		created := item
		if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
			return inserted, fmt.Errorf("nutrition: insert: %w", err)
		}
		inserted++
	}
	return inserted, nil
}
