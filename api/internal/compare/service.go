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

// Member is the minimal per-user input to the consent-gated leaderboard.
type Member struct {
	ID            uuid.UUID
	DisplayName   string
	ShareProgress bool
	TargetKcal    float64
}

// ProgressForMembers is the single consent gate: a member's metrics are
// computed ONLY when ShareProgress is true; otherwise the metric pointers
// stay nil and serialize away (omitempty).
func (s Service) ProgressForMembers(ctx context.Context, day time.Time, loc *time.Location, members []Member) ([]FriendProgress, error) {
	out := make([]FriendProgress, 0, len(members))
	for _, m := range members {
		fp := FriendProgress{ID: m.ID, DisplayName: m.DisplayName, Sharing: m.ShareProgress}
		if m.ShareProgress {
			metrics, err := progress.Compute(ctx, s.logs, m.ID, m.TargetKcal, day, loc)
			if err != nil {
				return nil, err
			}
			streak, adh := metrics.StreakDays, metrics.AdherenceDays
			fp.StreakDays = &streak
			fp.AdherenceDays = &adh
		}
		out = append(out, fp)
	}
	return out, nil
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
	members := make([]Member, 0, len(rows))
	for _, row := range rows {
		members = append(members, Member{ID: row.ID, DisplayName: row.DisplayName, ShareProgress: row.ShareProgress, TargetKcal: row.TargetKcal})
	}
	friends, err := s.ProgressForMembers(ctx, day, loc, members)
	if err != nil {
		return Result{}, err
	}
	return Result{Me: meMetrics, Friends: friends}, nil
}
