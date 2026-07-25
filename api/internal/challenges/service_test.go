package challenges

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/groups"
)

// --- in-memory stubs (no DB) ---

type memberRole struct {
	member bool
	role   groups.Role
	ok     bool
}

type stubGroups struct {
	m map[[2]uuid.UUID]memberRole // key: {groupID, userID}
}

func (s stubGroups) IsMember(_ context.Context, g, u uuid.UUID) (bool, error) {
	return s.m[[2]uuid.UUID{g, u}].member, nil
}
func (s stubGroups) RoleOf(_ context.Context, g, u uuid.UUID) (groups.Role, bool, error) {
	mr := s.m[[2]uuid.UUID{g, u}]
	return mr.role, mr.ok, nil
}

type stubStore struct {
	created      *Challenge
	participants map[uuid.UUID]map[uuid.UUID]bool // challengeID -> set of userIDs
	scoring      []ScoringRow
	find         *Challenge
	deleted      bool
}

func newStubStore() *stubStore {
	return &stubStore{participants: map[uuid.UUID]map[uuid.UUID]bool{}}
}
func (s *stubStore) Create(_ context.Context, groupID, creatorID uuid.UUID, title string, metric Metric, start, end time.Time) (Challenge, error) {
	ch := Challenge{ID: uuid.New(), GroupID: groupID, CreatorID: creatorID, Title: title, Metric: metric, StartDate: start, EndDate: end}
	s.created = &ch
	s.participants[ch.ID] = map[uuid.UUID]bool{creatorID: true}
	s.find = &ch
	return ch, nil
}
func (s *stubStore) FindByID(_ context.Context, id uuid.UUID) (*Challenge, error) {
	if s.find != nil && s.find.ID == id {
		return s.find, nil
	}
	return nil, nil
}
func (s *stubStore) ListForGroup(_ context.Context, _, _ uuid.UUID) ([]ChallengeSummary, error) {
	if s.find == nil {
		return []ChallengeSummary{}, nil
	}
	return []ChallengeSummary{{ID: s.find.ID, Title: s.find.Title, Metric: s.find.Metric, StartDate: s.find.StartDate, EndDate: s.find.EndDate, ParticipantCount: len(s.participants[s.find.ID])}}, nil
}
func (s *stubStore) AddParticipant(_ context.Context, cid, uid uuid.UUID) error {
	if s.participants[cid] == nil {
		s.participants[cid] = map[uuid.UUID]bool{}
	}
	s.participants[cid][uid] = true
	return nil
}
func (s *stubStore) RemoveParticipant(_ context.Context, cid, uid uuid.UUID) error {
	delete(s.participants[cid], uid)
	return nil
}
func (s *stubStore) IsParticipant(_ context.Context, cid, uid uuid.UUID) (bool, error) {
	return s.participants[cid][uid], nil
}
func (s *stubStore) ListParticipantsForScoring(_ context.Context, _ uuid.UUID) ([]ScoringRow, error) {
	return s.scoring, nil
}
func (s *stubStore) Delete(_ context.Context, _ uuid.UUID) error { s.deleted = true; return nil }

// DailyKcal-only stub for scoring.
type stubLogs struct{ kcal map[uuid.UUID]map[string]float64 }

func (s stubLogs) LoggedDaysDesc(_ context.Context, _ uuid.UUID, _ time.Time, _ *time.Location, _ int) ([]string, error) {
	return nil, nil
}
func (s stubLogs) DailyKcal(_ context.Context, u uuid.UUID, _, _ time.Time, _ *time.Location) (map[string]float64, error) {
	return s.kcal[u], nil
}

func member(g, u uuid.UUID, role groups.Role) map[[2]uuid.UUID]memberRole {
	return map[[2]uuid.UUID]memberRole{{g, u}: {member: true, role: role, ok: true}}
}

func TestCreateGatesNonMemberAndValidates(t *testing.T) {
	g, owner, stranger := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{})
	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC)

	// non-member cannot create
	_, err := svc.Create(context.Background(), stranger, g, "X", MetricLogged, "1w", now)
	require.ErrorIs(t, err, ErrForbidden)
	// blank title / bad metric / bad duration
	_, err = svc.Create(context.Background(), owner, g, "  ", MetricLogged, "1w", now)
	require.ErrorIs(t, err, ErrBadInput)
	_, err = svc.Create(context.Background(), owner, g, "X", Metric("bogus"), "1w", now)
	require.ErrorIs(t, err, ErrBadInput)
	_, err = svc.Create(context.Background(), owner, g, "X", MetricLogged, "5d", now)
	require.ErrorIs(t, err, ErrBadInput)

	// member creates -> auto-joined, end = today+7
	ch, err := svc.Create(context.Background(), owner, g, "Streak", MetricLogged, "1w", now)
	require.NoError(t, err)
	require.Equal(t, "Streak", ch.Title)
	require.Equal(t, "2026-07-26", ch.StartDate.Format("2006-01-02"))
	require.Equal(t, "2026-08-02", ch.EndDate.Format("2006-01-02"))
	isP, _ := store.IsParticipant(context.Background(), ch.ID, owner)
	require.True(t, isP)
}

func TestJoinLeaveGatedOnGroupMembership(t *testing.T) {
	g, owner, member2, stranger := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	groupsStub := stubGroups{m: map[[2]uuid.UUID]memberRole{
		{g, owner}:   {member: true, role: groups.RoleOwner, ok: true},
		{g, member2}: {member: true, role: groups.RoleMember, ok: true},
	}}
	svc := NewService(store, groupsStub, stubLogs{})
	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC)
	ch, _ := svc.Create(context.Background(), owner, g, "Streak", MetricLogged, "1w", now)

	require.ErrorIs(t, svc.Join(context.Background(), stranger, ch.ID), ErrForbidden)
	require.NoError(t, svc.Join(context.Background(), member2, ch.ID))
	require.NoError(t, svc.Join(context.Background(), member2, ch.ID)) // idempotent
	require.NoError(t, svc.Leave(context.Background(), member2, ch.ID))
	// unknown challenge -> 404
	require.ErrorIs(t, svc.Join(context.Background(), member2, uuid.New()), ErrNotFound)
}

func TestDetailStandingsSortAndWinner(t *testing.T) {
	g, owner, alice, bob := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{kcal: map[uuid.UUID]map[string]float64{
		alice: {"2026-07-01": 2000, "2026-07-02": 2000}, // 2 logged
		bob:   {"2026-07-01": 2000},                     // 1 logged
	}})
	// build an ended challenge directly in the stub
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: owner, Title: "Past", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 3)}
	store.find = &ch
	store.participants[ch.ID] = map[uuid.UUID]bool{alice: true, bob: true, owner: true}
	store.scoring = []ScoringRow{{ID: bob, DisplayName: "Bob", TargetKcal: 2000}, {ID: alice, DisplayName: "Alice", TargetKcal: 2000}, {ID: owner, DisplayName: "Owner", TargetKcal: 2000}}

	now := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC) // after end -> ended
	d, err := svc.Detail(context.Background(), owner, ch.ID, now, time.UTC)
	require.NoError(t, err)
	require.Equal(t, StatusEnded, d.Status)
	require.Len(t, d.Standings, 3)
	require.Equal(t, "Alice", d.Standings[0].DisplayName) // 2 > 1
	require.Equal(t, 2, d.Standings[0].Score)
	require.NotNil(t, d.Winner)
	require.Equal(t, "Alice", d.Winner.DisplayName)
	require.True(t, d.CanDelete) // owner is creator
}

func TestDetailActiveHasNoWinnerAndGatesNonMember(t *testing.T) {
	g, owner, stranger := uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	svc := NewService(store, stubGroups{m: member(g, owner, groups.RoleOwner)}, stubLogs{})
	start := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: owner, Title: "Now", Metric: MetricLogged, StartDate: start, EndDate: start.AddDate(0, 0, 7)}
	store.find = &ch
	store.participants[ch.ID] = map[uuid.UUID]bool{owner: true}

	now := time.Date(2026, 7, 26, 9, 0, 0, 0, time.UTC) // within window -> active
	d, err := svc.Detail(context.Background(), owner, ch.ID, now, time.UTC)
	require.NoError(t, err)
	require.Equal(t, StatusActive, d.Status)
	require.Nil(t, d.Winner)

	_, err = svc.Detail(context.Background(), stranger, ch.ID, now, time.UTC)
	require.ErrorIs(t, err, ErrForbidden)
}

func TestDeleteAllowsCreatorAndOwnerRejectsMember(t *testing.T) {
	g, owner, creator, plainMember := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := newStubStore()
	groupsStub := stubGroups{m: map[[2]uuid.UUID]memberRole{
		{g, owner}:       {member: true, role: groups.RoleOwner, ok: true},
		{g, creator}:     {member: true, role: groups.RoleMember, ok: true},
		{g, plainMember}: {member: true, role: groups.RoleMember, ok: true},
	}}
	svc := NewService(store, groupsStub, stubLogs{})
	ch := Challenge{ID: uuid.New(), GroupID: g, CreatorID: creator, Title: "X", Metric: MetricLogged}
	store.find = &ch

	// a plain member who is not the creator cannot delete
	require.ErrorIs(t, svc.Delete(context.Background(), plainMember, ch.ID), ErrForbidden)
	// the group owner can delete someone else's challenge
	require.NoError(t, svc.Delete(context.Background(), owner, ch.ID))
	// the creator can delete their own
	store.deleted = false
	require.NoError(t, svc.Delete(context.Background(), creator, ch.ID))
}
