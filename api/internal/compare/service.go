// Package compare composes a user's habit metrics with those of their
// sharing friends. The consent gate lives here: a friend's metrics are only
// computed when the caller holds a resolved access.Grant for them.
package compare

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
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
// Whether a member's metrics are visible is decided entirely by the grants
// map passed to ProgressForMembers/Compare -- it carries no consent flag of
// its own.
type Member struct {
	ID          uuid.UUID
	DisplayName string
	TargetKcal  float64
}

// Friends lists the caller's accepted friends as candidate leaderboard
// members. It does NOT decide who is visible -- callers resolve grants for
// the returned IDs (via access.Service.ResolveMany) before calling Compare or
// ProgressForMembers.
func (s Service) Friends(ctx context.Context, userID uuid.UUID) ([]Member, error) {
	rows, err := s.friends.ListAcceptedForCompare(ctx, userID)
	if err != nil {
		return nil, err
	}
	members := make([]Member, 0, len(rows))
	for _, row := range rows {
		members = append(members, Member{ID: row.ID, DisplayName: row.DisplayName, TargetKcal: row.TargetKcal})
	}
	return members, nil
}

// ProgressForMembers is the single consent gate: a member's metrics are
// computed ONLY when a resolved grant is present for them; otherwise the
// metric pointers stay nil and serialize away (omitempty).
//
// The grant map comes from access.Service.ResolveMany -- one query for the
// whole list, never one per member, because this path fans out over every
// friend or group member (kora#326).
func (s Service) ProgressForMembers(ctx context.Context, day time.Time, loc *time.Location,
	members []Member, grants map[uuid.UUID]access.Grant) ([]FriendProgress, error) {
	out := make([]FriendProgress, 0, len(members))
	for _, m := range members {
		_, shared := grants[m.ID]
		fp := FriendProgress{ID: m.ID, DisplayName: m.DisplayName, Sharing: shared}
		if shared {
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

// Compare composes the caller's own metrics with the gated metrics of the
// given members. members and grants are supplied by the caller so the grant
// resolution (one ResolveMany call, keyed by the same member IDs) happens
// exactly once per request.
func (s Service) Compare(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location,
	members []Member, grants map[uuid.UUID]access.Grant) (Result, error) {
	me, err := s.users.ByID(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	meMetrics, err := progress.Compute(ctx, s.logs, userID, me.TargetKcal, day, loc)
	if err != nil {
		return Result{}, err
	}
	friends, err := s.ProgressForMembers(ctx, day, loc, members, grants)
	if err != nil {
		return Result{}, err
	}
	return Result{Me: meMetrics, Friends: friends}, nil
}
