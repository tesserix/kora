package user

import (
	"context"
	"fmt"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) UpsertByFirebaseUID(ctx context.Context, firebaseUID, email string) (User, error) {
	u := User{FirebaseUID: firebaseUID, Email: email}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "firebase_uid"}},
			DoUpdates: clause.AssignmentColumns([]string{"email", "updated_at"}),
		}).
		Create(&u).Error
	if err != nil {
		return User{}, fmt.Errorf("user: upsert: %w", err)
	}
	var out User
	if err := r.db.WithContext(ctx).Where("firebase_uid = ?", firebaseUID).First(&out).Error; err != nil {
		return User{}, fmt.Errorf("user: fetch after upsert: %w", err)
	}
	return out, nil
}
