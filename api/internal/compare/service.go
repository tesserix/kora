// Package compare composes a user's habit metrics with those of their
// sharing friends. The consent gate lives here: a friend's metrics are only
// computed when their ShareProgress is true.
package compare

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/progress"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

type friendSource interface {
	ListAcceptedForCompare(ctx context.Context, userID uuid.UUID) ([]social.CompareRow, error)
}

type userSource interface {
	ByID(ctx context.Context, id uuid.UUID) (user.User, error)
}

type Service struct {
	friends friendSource
	users   userSource
	logs    progress.LogSource
}

func NewService(friends friendSource, users userSource, logs progress.LogSource) Service {
	return Service{friends: friends, users: users, logs: logs}
}

type FriendProgress struct {
	ID            uuid.UUID `json:"id"`
	DisplayName   string    `json:"display_name"`
	Sharing       bool      `json:"sharing"`
	StreakDays    *int      `json:"streak_days,omitempty"`
	AdherenceDays *int      `json:"adherence_days,omitempty"`
}

type Result struct {
	Me      progress.Metrics `json:"me"`
	Friends []FriendProgress `json:"friends"`
}

func (s Service) Compare(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (Result, error) {
	me, err := s.users.ByID(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	meMetrics, err := progress.Compute(ctx, s.logs, userID, me.TargetKcal, day, loc)
	if err != nil {
		return Result{}, err
	}
	rows, err := s.friends.ListAcceptedForCompare(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	friends := make([]FriendProgress, 0, len(rows))
	for _, row := range rows {
		fp := FriendProgress{ID: row.ID, DisplayName: row.DisplayName, Sharing: row.ShareProgress}
		if row.ShareProgress {
			m, err := progress.Compute(ctx, s.logs, row.ID, row.TargetKcal, day, loc)
			if err != nil {
				return Result{}, err
			}
			streak, adh := m.StreakDays, m.AdherenceDays
			fp.StreakDays = &streak
			fp.AdherenceDays = &adh
		}
		friends = append(friends, fp)
	}
	return Result{Me: meMetrics, Friends: friends}, nil
}
