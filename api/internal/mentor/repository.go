package mentor

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrNotFound = errors.New("mentor item not found")

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

func (r Repository) ProfileForUser(ctx context.Context, userID uuid.UUID) (Profile, bool, error) {
	var out Profile
	result := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&out)
	if result.Error != nil {
		return Profile{}, false, fmt.Errorf("mentor: load profile: %w", result.Error)
	}
	return out, result.RowsAffected == 1, nil
}

func (r Repository) UpsertProfile(ctx context.Context, profile Profile) error {
	profile.UpdatedAt = time.Now().UTC()
	if profile.CreatedAt.IsZero() {
		profile.CreatedAt = profile.UpdatedAt
	}
	err := r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"motivation", "dietary_preferences", "allergies", "coaching_style",
			"reminder_intensity", "quiet_start_minute", "quiet_end_minute",
			"health_steps_enabled", "health_sleep_enabled", "health_workouts_enabled",
			"confirmed_at", "updated_at",
		}),
	}).Create(&profile).Error
	if err != nil {
		return fmt.Errorf("mentor: upsert profile: %w", err)
	}
	return nil
}

func (r Repository) UpsertHealthDays(ctx context.Context, userID uuid.UUID, days []HealthDay) error {
	if len(days) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for i := range days {
		days[i].UserID = userID
		days[i].UpdatedAt = now
		if days[i].CreatedAt.IsZero() {
			days[i].CreatedAt = now
		}
	}
	err := r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}, {Name: "local_date"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"timezone", "steps", "sleep_minutes", "workout_minutes", "source",
			"observed_at", "updated_at",
		}),
	}).Create(&days).Error
	if err != nil {
		return fmt.Errorf("mentor: upsert health days: %w", err)
	}
	return nil
}

func (r Repository) HealthDaysSince(
	ctx context.Context,
	userID uuid.UUID,
	from time.Time,
	limit int,
) ([]HealthDay, error) {
	if limit <= 0 || limit > 31 {
		limit = 31
	}
	out := []HealthDay{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND local_date >= ?", userID, from).
		Order("local_date DESC").
		Limit(limit).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("mentor: list health days: %w", err)
	}
	return out, nil
}

func (r Repository) DeleteHealthDays(ctx context.Context, userID uuid.UUID) error {
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&HealthDay{}).Error; err != nil {
		return fmt.Errorf("mentor: delete health days: %w", err)
	}
	return nil
}

func (r Repository) PutCommitment(ctx context.Context, item Commitment) (Commitment, error) {
	var out Commitment
	result := r.db.WithContext(ctx).Raw(`
		INSERT INTO mentor_commitments (
			id, user_id, title, kind, cadence, weekdays_mask, start_minute,
			interval_minutes, end_minute, timezone, starts_on, ends_on,
			status, source, agent_name
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title,
			kind = EXCLUDED.kind,
			cadence = EXCLUDED.cadence,
			weekdays_mask = EXCLUDED.weekdays_mask,
			start_minute = EXCLUDED.start_minute,
			interval_minutes = EXCLUDED.interval_minutes,
			end_minute = EXCLUDED.end_minute,
			timezone = EXCLUDED.timezone,
			starts_on = EXCLUDED.starts_on,
			ends_on = EXCLUDED.ends_on,
			status = EXCLUDED.status,
			updated_at = now()
		WHERE mentor_commitments.user_id = EXCLUDED.user_id
		RETURNING id, user_id, title, kind, cadence, weekdays_mask, start_minute,
			interval_minutes, end_minute, timezone, starts_on, ends_on, status,
			source, agent_name, created_at, updated_at`,
		item.ID, item.UserID, item.Title, item.Kind, item.Cadence, item.WeekdaysMask,
		item.StartMinute, item.IntervalMinutes, item.EndMinute, item.Timezone,
		item.StartsOn, item.EndsOn, item.Status, item.Source, item.AgentName,
	).Scan(&out)
	if result.Error != nil {
		return Commitment{}, fmt.Errorf("mentor: put commitment: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return Commitment{}, ErrNotFound
	}
	return out, nil
}

func (r Repository) CommitmentForUser(
	ctx context.Context,
	userID, commitmentID uuid.UUID,
) (Commitment, error) {
	var out Commitment
	err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", commitmentID, userID).
		First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Commitment{}, ErrNotFound
	}
	if err != nil {
		return Commitment{}, fmt.Errorf("mentor: load commitment: %w", err)
	}
	return out, nil
}

func (r Repository) ActiveCommitments(
	ctx context.Context,
	userID uuid.UUID,
	on time.Time,
	limit int,
) ([]Commitment, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	out := []Commitment{}
	err := r.db.WithContext(ctx).
		Where(`user_id = ? AND status = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)`,
			userID, CommitmentStatusActive, on, on).
		Order("start_minute ASC, id ASC").
		Limit(limit).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("mentor: list active commitments: %w", err)
	}
	return out, nil
}

func (r Repository) ListCommitments(ctx context.Context, userID uuid.UUID, limit int) ([]Commitment, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	out := []Commitment{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND status <> ?", userID, CommitmentStatusArchived).
		Order("status ASC, start_minute ASC, id ASC").
		Limit(limit).
		Find(&out).Error
	if err != nil {
		return nil, fmt.Errorf("mentor: list commitments: %w", err)
	}
	return out, nil
}

func (r Repository) ProposalForUser(
	ctx context.Context,
	userID, proposalID uuid.UUID,
) (CommitmentProposal, error) {
	var out CommitmentProposal
	err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", proposalID, userID).
		First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return CommitmentProposal{}, ErrNotFound
	}
	if err != nil {
		return CommitmentProposal{}, fmt.Errorf("mentor: load commitment proposal: %w", err)
	}
	return out, nil
}

func (r Repository) AcceptProposal(
	ctx context.Context,
	userID, proposalID uuid.UUID,
	item Commitment,
) (Commitment, error) {
	var out Commitment
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var proposal CommitmentProposal
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ?", proposalID, userID).
			First(&proposal).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if proposal.AcceptedCommitmentID != nil {
			return tx.Where("id = ? AND user_id = ?", *proposal.AcceptedCommitmentID, userID).
				First(&out).Error
		}

		agentName := proposal.AgentName
		item.UserID = userID
		item.Source = proposal.Source
		item.AgentName = &agentName
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		if err := tx.Model(&CommitmentProposal{}).
			Where("id = ? AND user_id = ?", proposalID, userID).
			Updates(map[string]any{
				"accepted_commitment_id": item.ID,
				"accepted_at":            now,
			}).Error; err != nil {
			return err
		}
		out = item
		return nil
	})
	if errors.Is(err, ErrNotFound) || errors.Is(err, gorm.ErrRecordNotFound) {
		return Commitment{}, ErrNotFound
	}
	if err != nil {
		return Commitment{}, fmt.Errorf("mentor: accept commitment proposal: %w", err)
	}
	return out, nil
}

func (r Repository) PutCheckIn(
	ctx context.Context,
	userID, commitmentID uuid.UUID,
	checkIn CheckIn,
) (CheckIn, error) {
	var out CheckIn
	result := r.db.WithContext(ctx).Raw(`
		INSERT INTO mentor_check_ins (
			user_id, commitment_id, scheduled_for, local_date, action, snoozed_until
		)
		SELECT ?, id, ?, ?, ?, ?
		FROM mentor_commitments
		WHERE id = ? AND user_id = ?
		ON CONFLICT (commitment_id, scheduled_for) DO UPDATE SET
			action = EXCLUDED.action,
			local_date = EXCLUDED.local_date,
			snoozed_until = EXCLUDED.snoozed_until,
			updated_at = now()
		WHERE mentor_check_ins.user_id = EXCLUDED.user_id
		RETURNING id, user_id, commitment_id, scheduled_for, local_date, action,
			snoozed_until, created_at, updated_at`,
		userID, checkIn.ScheduledFor, checkIn.LocalDate, checkIn.Action,
		checkIn.SnoozedUntil, commitmentID, userID,
	).Scan(&out)
	if result.Error != nil {
		return CheckIn{}, fmt.Errorf("mentor: put check-in: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return CheckIn{}, ErrNotFound
	}
	return out, nil
}
