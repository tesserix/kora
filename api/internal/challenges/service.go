package challenges

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/groups"
	"github.com/tesserix/kora/api/internal/progress"
)

// challengeStore is the persistence surface the service needs (Repository satisfies it).
type challengeStore interface {
	Create(ctx context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error)
	FindByID(ctx context.Context, id uuid.UUID) (*Challenge, error)
	ListForGroup(ctx context.Context, groupID, viewerID uuid.UUID) ([]ChallengeSummary, error)
	AddParticipant(ctx context.Context, challengeID, userID uuid.UUID) error
	RemoveParticipant(ctx context.Context, challengeID, userID uuid.UUID) error
	IsParticipant(ctx context.Context, challengeID, userID uuid.UUID) (bool, error)
	ListParticipantsForScoring(ctx context.Context, challengeID uuid.UUID) ([]ScoringRow, error)
	Delete(ctx context.Context, challengeID uuid.UUID) error
}

// groupAccess is the membership/ownership surface (groups.Repository satisfies it).
type groupAccess interface {
	IsMember(ctx context.Context, groupID, userID uuid.UUID) (bool, error)
	RoleOf(ctx context.Context, groupID, userID uuid.UUID) (groups.Role, bool, error)
}

type notifier interface {
	ChallengeCreated(ctx context.Context, groupID, actorID, challengeID uuid.UUID) error
}

type Service struct {
	repo     challengeStore
	groups   groupAccess
	logs     progress.LogSource
	notifier notifier
}

func NewService(repo challengeStore, groupAcc groupAccess, logs progress.LogSource) Service {
	return Service{repo: repo, groups: groupAcc, logs: logs}
}

func (s Service) WithNotifier(n notifier) Service {
	s.notifier = n
	return s
}

func (s Service) Create(ctx context.Context, userID, groupID uuid.UUID, title string, metric Metric, duration string, now time.Time) (Challenge, error) {
	isM, err := s.groups.IsMember(ctx, groupID, userID)
	if err != nil {
		return Challenge{}, err
	}
	if !isM {
		return Challenge{}, ErrForbidden
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return Challenge{}, ErrBadInput
	}
	if !ValidMetric(string(metric)) {
		return Challenge{}, ErrBadInput
	}
	days, ok := durationDays[duration]
	if !ok {
		return Challenge{}, ErrBadInput
	}
	y, m, d := now.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, days)
	ch, err := s.repo.Create(ctx, groupID, userID, title, metric, start, end)
	if err != nil {
		return Challenge{}, err
	}
	if s.notifier != nil {
		if nerr := s.notifier.ChallengeCreated(ctx, groupID, userID, ch.ID); nerr != nil {
			slog.WarnContext(ctx, "notify challenge created failed", "err", nerr)
		}
	}
	return ch, nil
}

func (s Service) List(ctx context.Context, userID, groupID uuid.UUID, now time.Time, loc *time.Location) ([]ChallengeSummary, error) {
	isM, err := s.groups.IsMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if !isM {
		return nil, ErrForbidden
	}
	out, err := s.repo.ListForGroup(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Status = Status(out[i].StartDate, out[i].EndDate, now, loc)
	}
	return out, nil
}

func (s Service) Join(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return err
	}
	return s.repo.AddParticipant(ctx, ch.ID, userID)
}

func (s Service) Leave(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return err
	}
	return s.repo.RemoveParticipant(ctx, ch.ID, userID)
}

func (s Service) Detail(ctx context.Context, userID, challengeID uuid.UUID, now time.Time, loc *time.Location) (ChallengeDetail, error) {
	ch, err := s.mustMember(ctx, userID, challengeID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	status := Status(ch.StartDate, ch.EndDate, now, loc)
	rows, err := s.repo.ListParticipantsForScoring(ctx, ch.ID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	standings := make([]Standing, 0, len(rows))
	for _, r := range rows {
		score, err := progress.WindowScore(ctx, s.logs, r.ID, string(ch.Metric), r.TargetKcal, ch.StartDate, ch.EndDate, loc)
		if err != nil {
			return ChallengeDetail{}, err
		}
		standings = append(standings, Standing{UserID: r.ID, DisplayName: r.DisplayName, Score: score})
	}
	sort.SliceStable(standings, func(i, j int) bool {
		if standings[i].Score != standings[j].Score {
			return standings[i].Score > standings[j].Score
		}
		return standings[i].DisplayName < standings[j].DisplayName
	})
	joined, err := s.repo.IsParticipant(ctx, ch.ID, userID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	owner, err := s.isGroupOwner(ctx, ch.GroupID, userID)
	if err != nil {
		return ChallengeDetail{}, err
	}
	var winner *Standing
	if status == StatusEnded && len(standings) > 0 {
		w := standings[0]
		winner = &w
	}
	return ChallengeDetail{
		ID: ch.ID, GroupID: ch.GroupID, Title: ch.Title, Metric: ch.Metric, Status: status,
		StartDate: ch.StartDate, EndDate: ch.EndDate,
		Joined: joined, CanDelete: userID == ch.CreatorID || owner,
		Standings: standings, Winner: winner,
	}, nil
}

func (s Service) Delete(ctx context.Context, userID, challengeID uuid.UUID) error {
	ch, err := s.repo.FindByID(ctx, challengeID)
	if err != nil {
		return err
	}
	if ch == nil {
		return ErrNotFound
	}
	if userID != ch.CreatorID {
		owner, err := s.isGroupOwner(ctx, ch.GroupID, userID)
		if err != nil {
			return err
		}
		if !owner {
			return ErrForbidden
		}
	}
	return s.repo.Delete(ctx, ch.ID)
}

// mustMember resolves a challenge and asserts the user is a member of its group.
func (s Service) mustMember(ctx context.Context, userID, challengeID uuid.UUID) (*Challenge, error) {
	ch, err := s.repo.FindByID(ctx, challengeID)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, ErrNotFound
	}
	isM, err := s.groups.IsMember(ctx, ch.GroupID, userID)
	if err != nil {
		return nil, err
	}
	if !isM {
		return nil, ErrForbidden
	}
	return ch, nil
}

func (s Service) isGroupOwner(ctx context.Context, groupID, userID uuid.UUID) (bool, error) {
	role, ok, err := s.groups.RoleOf(ctx, groupID, userID)
	if err != nil {
		return false, err
	}
	return ok && role == groups.RoleOwner, nil
}
