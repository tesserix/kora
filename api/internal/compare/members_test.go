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
	svc := NewService(stubFriends{}, stubUsers{target: 2000}, stubLogs{})
	sharer := uuid.New()
	private := uuid.New()
	grants := map[uuid.UUID]access.Grant{sharer: {}}
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
