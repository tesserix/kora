package challenges

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) Create(ctx context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error) {
	ch := Challenge{GroupID: groupID, CreatorID: creatorID, Title: title, Metric: metric, StartDate: start, EndDate: end}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&ch).Error; err != nil {
			return err
		}
		return tx.Create(&ChallengeParticipant{ChallengeID: ch.ID, UserID: creatorID}).Error
	})
	if err != nil {
		return Challenge{}, fmt.Errorf("challenges: create: %w", err)
	}
	return ch, nil
}

func (r Repository) FindByID(ctx context.Context, id uuid.UUID) (*Challenge, error) {
	var ch Challenge
	err := r.db.WithContext(ctx).First(&ch, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("challenges: find by id: %w", err)
	}
	return &ch, nil
}

func (r Repository) ListForGroup(ctx context.Context, groupID, viewerID uuid.UUID) ([]ChallengeSummary, error) {
	out := []ChallengeSummary{}
	err := r.db.WithContext(ctx).
		Table("challenges AS c").
		Select("c.id AS id, c.title AS title, c.metric AS metric, c.start_date AS start_date, c.end_date AS end_date, "+
			"(SELECT count(*) FROM challenge_participants p WHERE p.challenge_id = c.id) AS participant_count, "+
			"EXISTS(SELECT 1 FROM challenge_participants p2 WHERE p2.challenge_id = c.id AND p2.user_id = ?) AS joined", viewerID).
		Where("c.group_id = ?", groupID).
		Order("c.created_at DESC").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list for group: %w", err)
	}
	return out, nil
}

func (r Repository) AddParticipant(ctx context.Context, challengeID, userID uuid.UUID) error {
	p := ChallengeParticipant{ChallengeID: challengeID, UserID: userID}
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&p).Error
	if err != nil {
		return fmt.Errorf("challenges: add participant: %w", err)
	}
	return nil
}

func (r Repository) RemoveParticipant(ctx context.Context, challengeID, userID uuid.UUID) error {
	if err := r.db.WithContext(ctx).
		Where("challenge_id = ? AND user_id = ?", challengeID, userID).
		Delete(&ChallengeParticipant{}).Error; err != nil {
		return fmt.Errorf("challenges: remove participant: %w", err)
	}
	return nil
}

func (r Repository) IsParticipant(ctx context.Context, challengeID, userID uuid.UUID) (bool, error) {
	var count int64
	if err := r.db.WithContext(ctx).Model(&ChallengeParticipant{}).
		Where("challenge_id = ? AND user_id = ?", challengeID, userID).
		Count(&count).Error; err != nil {
		return false, fmt.Errorf("challenges: is participant: %w", err)
	}
	return count > 0, nil
}

func (r Repository) ListParticipantsForScoring(ctx context.Context, challengeID uuid.UUID) ([]ScoringRow, error) {
	out := []ScoringRow{}
	err := r.db.WithContext(ctx).
		Table("challenge_participants AS p").
		Select("u.id AS id, u.display_name AS display_name, u.target_kcal AS target_kcal").
		Joins("JOIN users u ON u.id = p.user_id").
		Where("p.challenge_id = ?", challengeID).
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("challenges: list participants for scoring: %w", err)
	}
	return out, nil
}

func (r Repository) Delete(ctx context.Context, challengeID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Delete(&Challenge{}, "id = ?", challengeID).Error; err != nil {
		return fmt.Errorf("challenges: delete: %w", err)
	}
	return nil
}
