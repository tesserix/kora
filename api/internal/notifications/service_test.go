package notifications

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/groups"
)

type stubStore struct{ created []Notification }

func (s *stubStore) Create(_ context.Context, n Notification) error {
	s.created = append(s.created, n)
	return nil
}
func (s *stubStore) ListForUser(_ context.Context, _ uuid.UUID, _ int) ([]NotificationView, error) {
	return nil, nil
}
func (s *stubStore) UnreadCount(_ context.Context, _ uuid.UUID) (int, error) { return 0, nil }
func (s *stubStore) MarkAllRead(_ context.Context, _ uuid.UUID) (int, error) { return 0, nil }

type stubMembers struct{ members []groups.MemberView }

func (s stubMembers) ListMembers(_ context.Context, _ uuid.UUID) ([]groups.MemberView, error) {
	return s.members, nil
}

func TestOneToOneNotifiers(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	recipient, actor, gid := uuid.New(), uuid.New(), uuid.New()

	require.NoError(t, svc.FriendRequested(context.Background(), recipient, actor))
	require.NoError(t, svc.AddedToGroup(context.Background(), recipient, actor, gid))
	require.Len(t, store.created, 2)
	require.Equal(t, TypeFriendRequest, store.created[0].Type)
	require.Equal(t, recipient, store.created[0].UserID)
	require.Nil(t, store.created[0].EntityID)
	require.Equal(t, TypeGroupInvite, store.created[1].Type)
	require.NotNil(t, store.created[1].EntityID)
	require.Equal(t, gid, *store.created[1].EntityID)
}

func TestChallengeCreatedFansOutExcludingActor(t *testing.T) {
	creator, m1, m2, gid, cid := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := &stubStore{}
	svc := NewService(store, stubMembers{members: []groups.MemberView{
		{ID: creator, DisplayName: "Creator", Role: groups.RoleOwner},
		{ID: m1, DisplayName: "M1", Role: groups.RoleMember},
		{ID: m2, DisplayName: "M2", Role: groups.RoleMember},
	}})

	require.NoError(t, svc.ChallengeCreated(context.Background(), gid, creator, cid))
	// two rows — one per member != creator
	require.Len(t, store.created, 2)
	got := map[uuid.UUID]bool{store.created[0].UserID: true, store.created[1].UserID: true}
	require.True(t, got[m1] && got[m2])
	require.False(t, got[creator])
	for _, n := range store.created {
		require.Equal(t, TypeChallengeCreated, n.Type)
		require.NotNil(t, n.EntityID)
		require.Equal(t, cid, *n.EntityID)
		require.Equal(t, creator, n.ActorID)
	}
}
