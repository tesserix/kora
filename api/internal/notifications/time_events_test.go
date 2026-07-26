package notifications

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestChallengeStartedWritesToAllParticipants(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, creator, m1, m2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengeStarted(context.Background(), cid, []uuid.UUID{creator, m1, m2}, creator))
	require.Len(t, store.created, 3)
	for _, n := range store.created {
		require.Equal(t, TypeChallengeStarted, n.Type)
		require.Equal(t, creator, n.ActorID)
		require.NotNil(t, n.EntityID)
		require.Equal(t, cid, *n.EntityID)
	}
}

func TestChallengeEndedActorIsWinner(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, winner, m1 := uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengeEnded(context.Background(), cid, []uuid.UUID{winner, m1}, winner))
	require.Len(t, store.created, 2)
	for _, n := range store.created {
		require.Equal(t, TypeChallengeEnded, n.Type)
		require.Equal(t, winner, n.ActorID)
		require.Equal(t, cid, *n.EntityID)
	}
}

func TestChallengePassedWritesOneRowToPassedUser(t *testing.T) {
	store := &stubStore{}
	svc := NewService(store, stubMembers{})
	cid, passed, ahead := uuid.New(), uuid.New(), uuid.New()
	require.NoError(t, svc.ChallengePassed(context.Background(), cid, passed, ahead))
	require.Len(t, store.created, 1)
	require.Equal(t, TypeChallengePassed, store.created[0].Type)
	require.Equal(t, passed, store.created[0].UserID)
	require.Equal(t, ahead, store.created[0].ActorID)
	require.Equal(t, cid, *store.created[0].EntityID)
}
