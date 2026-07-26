// Package scheduler runs a periodic tick that writes challenge time-event
// notifications (started / ended / passed) to the feed.
package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/challenges"
)

// challengeData is the persistence surface (challenges.Repository satisfies it).
type challengeData interface {
	ListDueForStart(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ListDueForEnd(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ListActive(ctx context.Context, today time.Time) ([]challenges.Challenge, error)
	ParticipantIDs(ctx context.Context, challengeID uuid.UUID) ([]uuid.UUID, error)
	ParticipantRanks(ctx context.Context, challengeID uuid.UUID) (map[uuid.UUID]*int, error)
	SetLastRanks(ctx context.Context, challengeID uuid.UUID, ranks map[uuid.UUID]int) error
	MarkStartedNotified(ctx context.Context, id uuid.UUID) error
	MarkEndedNotified(ctx context.Context, id uuid.UUID) error
}

// standingsSource ranks a challenge (challenges.Service satisfies it).
type standingsSource interface {
	Standings(ctx context.Context, challengeID uuid.UUID, loc *time.Location) ([]challenges.Standing, error)
}

// notifier writes the time-event notifications (notifications.Service satisfies it).
type notifier interface {
	ChallengeStarted(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, creatorID uuid.UUID) error
	ChallengeEnded(ctx context.Context, challengeID uuid.UUID, participantIDs []uuid.UUID, winnerID uuid.UUID) error
	ChallengePassed(ctx context.Context, challengeID, passedUserID, aheadUserID uuid.UUID) error
}

type Scheduler struct {
	data     challengeData
	stand    standingsSource
	notif    notifier
	loc      *time.Location
	interval time.Duration
	log      *slog.Logger
}

func New(data challengeData, stand standingsSource, notif notifier, loc *time.Location, interval time.Duration, log *slog.Logger) *Scheduler {
	return &Scheduler{data: data, stand: stand, notif: notif, loc: loc, interval: interval, log: log}
}

// Run ticks until ctx is cancelled. A tick error is logged; the loop continues.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Tick(ctx, time.Now()); err != nil {
				s.log.WarnContext(ctx, "scheduler tick failed", "err", err)
			}
		}
	}
}

// Tick performs one pass: started, ended, then passed detection.
func (s *Scheduler) Tick(ctx context.Context, now time.Time) error {
	today := now.In(s.loc)

	due, err := s.data.ListDueForStart(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range due {
		pids, err := s.data.ParticipantIDs(ctx, ch.ID)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: participant ids", "challenge", ch.ID, "err", err)
			continue
		}
		if err := s.notif.ChallengeStarted(ctx, ch.ID, pids, ch.CreatorID); err != nil {
			s.log.WarnContext(ctx, "scheduler: notify started", "challenge", ch.ID, "err", err)
			continue // do not mark → retry next tick
		}
		if err := s.data.MarkStartedNotified(ctx, ch.ID); err != nil {
			s.log.WarnContext(ctx, "scheduler: mark started", "challenge", ch.ID, "err", err)
		}
	}

	ended, err := s.data.ListDueForEnd(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range ended {
		st, err := s.stand.Standings(ctx, ch.ID, s.loc)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: standings (end)", "challenge", ch.ID, "err", err)
			continue
		}
		if len(st) > 0 {
			pids, err := s.data.ParticipantIDs(ctx, ch.ID)
			if err != nil {
				s.log.WarnContext(ctx, "scheduler: participant ids (end)", "challenge", ch.ID, "err", err)
				continue
			}
			if err := s.notif.ChallengeEnded(ctx, ch.ID, pids, st[0].UserID); err != nil {
				s.log.WarnContext(ctx, "scheduler: notify ended", "challenge", ch.ID, "err", err)
				continue // do not mark → retry
			}
		}
		if err := s.data.MarkEndedNotified(ctx, ch.ID); err != nil {
			s.log.WarnContext(ctx, "scheduler: mark ended", "challenge", ch.ID, "err", err)
		}
	}

	active, err := s.data.ListActive(ctx, today)
	if err != nil {
		return err
	}
	for _, ch := range active {
		st, err := s.stand.Standings(ctx, ch.ID, s.loc)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: standings (active)", "challenge", ch.ID, "err", err)
			continue
		}
		prev, err := s.data.ParticipantRanks(ctx, ch.ID)
		if err != nil {
			s.log.WarnContext(ctx, "scheduler: ranks", "challenge", ch.ID, "err", err)
			continue
		}
		newRanks := make(map[uuid.UUID]int, len(st))
		for i, standing := range st {
			rank := i + 1
			newRanks[standing.UserID] = rank
			if last := prev[standing.UserID]; last != nil && rank > *last {
				ahead := st[i-1].UserID
				if err := s.notif.ChallengePassed(ctx, ch.ID, standing.UserID, ahead); err != nil {
					s.log.WarnContext(ctx, "scheduler: notify passed", "challenge", ch.ID, "err", err)
				}
			}
		}
		// Unlike started/ended (which retry on notify failure), the passed
		// baseline advances every tick regardless of ChallengePassed's result:
		// a missed pass-notify is intentionally dropped (passed is approximate).
		if err := s.data.SetLastRanks(ctx, ch.ID, newRanks); err != nil {
			s.log.WarnContext(ctx, "scheduler: set ranks", "challenge", ch.ID, "err", err)
		}
	}
	return nil
}
