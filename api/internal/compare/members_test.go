package compare

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
)

func TestProgressForMembersGatesNonSharers(t *testing.T) {
	db := testDB(t)
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, stubLogs{})
	viewer := seedUser(t, db, "viewer")
	sharer := seedUser(t, db, "sharer")
	private := seedUser(t, db, "private")
	// A real Grant, not Grant{} -- see access_test_helpers_test.go for why a
	// zero-value grant can no longer stand in once ProgressForMembers queries
	// by grant.Owner() instead of the caller-supplied member ID.
	grants := map[uuid.UUID]access.Grant{sharer: seedGrant(t, db, viewer, sharer, access.CategoryProgress)}
	out, err := svc.ProgressForMembers(context.Background(), time.Now(), time.UTC, []Member{
		{ID: sharer, DisplayName: "Sharer", TargetKcal: 2000},
		{ID: private, DisplayName: "Private", TargetKcal: 2000},
	}, grants)
	require.NoError(t, err)
	require.Len(t, out, 2)
	byName := map[string]FriendProgress{}
	for _, f := range out {
		byName[f.DisplayName] = f
	}
	require.True(t, byName["Sharer"].Sharing)
	require.NotNil(t, byName["Sharer"].StreakDays)
	require.False(t, byName["Private"].Sharing)
	require.Nil(t, byName["Private"].StreakDays)
	require.Nil(t, byName["Private"].AdherenceDays)
}

// spyLogs records the userID it was queried with, so tests can assert WHICH
// id the metrics query actually ran against.
type spyLogs struct{ lastID uuid.UUID }

func (s *spyLogs) LoggedDaysDesc(_ context.Context, userID uuid.UUID, _ time.Time, _ int) ([]string, error) {
	s.lastID = userID
	return []string{}, nil
}

func (s *spyLogs) DailyKcal(_ context.Context, userID uuid.UUID, _, _ time.Time) (map[string]float64, error) {
	s.lastID = userID
	return map[string]float64{}, nil
}

// TestProgressForMembersQueriesByGrantOwnerNotMemberID pins F3 from the
// kora#326 whole-branch review: the metrics query must run against
// grant.Owner(), not the caller-supplied member ID that happens to key the
// grants map. It deliberately mismatches the two -- the grants map is keyed
// by `sharer` (the Member.ID the caller controls) but the Grant stored there
// resolves to a DIFFERENT owner (`trueOwner`), which is the only way to
// distinguish "queried by map key" from "queried by grant.Owner()" when
// production code always keeps the two aligned.
func TestProgressForMembersQueriesByGrantOwnerNotMemberID(t *testing.T) {
	db := testDB(t)
	spy := &spyLogs{}
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, spy)
	viewer := seedUser(t, db, "viewer")
	sharer := seedUser(t, db, "sharer")   // the Member.ID / grants map key
	trueOwner := seedUser(t, db, "owner") // what the Grant actually attests to
	grants := map[uuid.UUID]access.Grant{
		sharer: seedGrant(t, db, viewer, trueOwner, access.CategoryProgress),
	}

	_, err := svc.ProgressForMembers(context.Background(), time.Now(), time.UTC, []Member{
		{ID: sharer, DisplayName: "Sharer", TargetKcal: 2000},
	}, grants)
	require.NoError(t, err)
	require.Equal(t, trueOwner, spy.lastID, "metrics must be queried for grant.Owner(), not the member ID")
}
