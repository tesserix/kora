package compare

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
)

// THE invariant for this task: a member with no grant gets no metrics, and the
// pointers stay nil so they serialize away. Replaces the old ShareProgress
// bool with the same behaviour driven by a resolved grant.
func TestMemberWithoutAGrantGetsNoMetrics(t *testing.T) {
	svc := NewService(nil, nil, stubLogs{})
	member := Member{ID: uuid.New(), DisplayName: "friend", TargetKcal: 2000}

	out, err := svc.ProgressForMembers(context.Background(), time.Now(), time.UTC,
		[]Member{member}, map[uuid.UUID]access.Grant{})

	require.NoError(t, err)
	require.Len(t, out, 1)
	require.False(t, out[0].Sharing)
	require.Nil(t, out[0].StreakDays)
	require.Nil(t, out[0].AdherenceDays)
}
