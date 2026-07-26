package scheduler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/challenges"
)

func intp(i int) *int { return &i }

type stubData struct {
	dueStart, dueEnd, active   []challenges.Challenge
	participants               map[uuid.UUID][]uuid.UUID
	ranks                      map[uuid.UUID]map[uuid.UUID]*int
	standings                  map[uuid.UUID][]challenges.Standing
	startedMarked, endedMarked []uuid.UUID
	setRanks                   map[uuid.UUID]map[uuid.UUID]int
}

func (s *stubData) ListDueForStart(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.dueStart, nil
}
func (s *stubData) ListDueForEnd(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.dueEnd, nil
}
func (s *stubData) ListActive(context.Context, time.Time) ([]challenges.Challenge, error) {
	return s.active, nil
}
func (s *stubData) ParticipantIDs(_ context.Context, cid uuid.UUID) ([]uuid.UUID, error) {
	return s.participants[cid], nil
}
func (s *stubData) ParticipantRanks(_ context.Context, cid uuid.UUID) (map[uuid.UUID]*int, error) {
	return s.ranks[cid], nil
}
func (s *stubData) SetLastRanks(_ context.Context, cid uuid.UUID, r map[uuid.UUID]int) error {
	if s.setRanks == nil {
		s.setRanks = map[uuid.UUID]map[uuid.UUID]int{}
	}
	s.setRanks[cid] = r
	return nil
}
func (s *stubData) MarkStartedNotified(_ context.Context, id uuid.UUID) error {
	s.startedMarked = append(s.startedMarked, id)
	return nil
}
func (s *stubData) MarkEndedNotified(_ context.Context, id uuid.UUID) error {
	s.endedMarked = append(s.endedMarked, id)
	return nil
}

type stubStand struct {
	m map[uuid.UUID][]challenges.Standing
}

func (s stubStand) Standings(_ context.Context, cid uuid.UUID, _ *time.Location) ([]challenges.Standing, error) {
	return s.m[cid], nil
}

type startedCall struct {
	cid     uuid.UUID
	pids    []uuid.UUID
	creator uuid.UUID
}
type endedCall struct {
	cid    uuid.UUID
	pids   []uuid.UUID
	winner uuid.UUID
}
type passedCall struct {
	cid, passed, ahead uuid.UUID
}

type stubNotif struct {
	started []startedCall
	ended   []endedCall
	passed  []passedCall
	fail    bool
}

func (s *stubNotif) ChallengeStarted(_ context.Context, cid uuid.UUID, pids []uuid.UUID, creator uuid.UUID) error {
	if s.fail {
		return errors.New("boom")
	}
	s.started = append(s.started, startedCall{cid, pids, creator})
	return nil
}
func (s *stubNotif) ChallengeEnded(_ context.Context, cid uuid.UUID, pids []uuid.UUID, winner uuid.UUID) error {
	s.ended = append(s.ended, endedCall{cid, pids, winner})
	return nil
}
func (s *stubNotif) ChallengePassed(_ context.Context, cid, passed, ahead uuid.UUID) error {
	s.passed = append(s.passed, passedCall{cid, passed, ahead})
	return nil
}

func newLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func now() time.Time          { return time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC) }

func TestTickStartedNotifiesAndMarks(t *testing.T) {
	cid, creator, m1 := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		dueStart:     []challenges.Challenge{{ID: cid, CreatorID: creator}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {creator, m1}},
	}
	notif := &stubNotif{}
	s := New(data, stubStand{}, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.started, 1)
	require.Equal(t, creator, notif.started[0].creator)
	require.Equal(t, []uuid.UUID{cid}, data.startedMarked) // marked after notify
}

func TestTickStartedNotifyErrorDoesNotMark(t *testing.T) {
	cid := uuid.New()
	data := &stubData{dueStart: []challenges.Challenge{{ID: cid}}, participants: map[uuid.UUID][]uuid.UUID{cid: {uuid.New()}}}
	notif := &stubNotif{fail: true}
	s := New(data, stubStand{}, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now())) // tick itself doesn't error
	require.Empty(t, data.startedMarked, "must not mark when notify failed")
}

func TestTickEndedNotifiesWinner(t *testing.T) {
	cid, winner, loser := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		dueEnd:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {winner, loser}},
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: winner, Score: 5}, {UserID: loser, Score: 2}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.ended, 1)
	require.Equal(t, winner, notif.ended[0].winner)
	require.Equal(t, []uuid.UUID{cid}, data.endedMarked)
}

func TestTickPassedFiresOnWorseningNotFirstSeen(t *testing.T) {
	cid, alice, bob := uuid.New(), uuid.New(), uuid.New()
	// alice was rank 1, bob was rank 2; now bob is rank 1, alice rank 2 -> alice was passed by bob.
	data := &stubData{
		active:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {alice, bob}},
		ranks:        map[uuid.UUID]map[uuid.UUID]*int{cid: {alice: intp(1), bob: intp(2)}},
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: bob, DisplayName: "Bob"}, {UserID: alice, DisplayName: "Alice"}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Len(t, notif.passed, 1)
	require.Equal(t, alice, notif.passed[0].passed)
	require.Equal(t, bob, notif.passed[0].ahead) // person now directly ahead
	require.Equal(t, 1, data.setRanks[cid][bob])
	require.Equal(t, 2, data.setRanks[cid][alice])
}

func TestTickPassedNoNotifyOnFirstSeen(t *testing.T) {
	cid, alice, bob := uuid.New(), uuid.New(), uuid.New()
	data := &stubData{
		active:       []challenges.Challenge{{ID: cid}},
		participants: map[uuid.UUID][]uuid.UUID{cid: {alice, bob}},
		ranks:        map[uuid.UUID]map[uuid.UUID]*int{cid: {}}, // no prior ranks
	}
	stand := stubStand{m: map[uuid.UUID][]challenges.Standing{cid: {{UserID: bob}, {UserID: alice}}}}
	notif := &stubNotif{}
	s := New(data, stand, notif, time.UTC, time.Minute, newLogger())
	require.NoError(t, s.Tick(context.Background(), now()))
	require.Empty(t, notif.passed, "first-seen sets baseline, no notify")
	require.Equal(t, 1, data.setRanks[cid][bob]) // baseline written
}
