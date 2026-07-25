package groups

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

type stubFriends struct{ pairs map[[2]uuid.UUID]bool }

func (s stubFriends) AreFriends(_ context.Context, a, b uuid.UUID) (bool, error) {
	return s.pairs[[2]uuid.UUID{a, b}] || s.pairs[[2]uuid.UUID{b, a}], nil
}

func seqCode() func() (string, error) {
	n := 0
	return func() (string, error) { n++; return "SVCCODE" + string(rune('A'+n)), nil }
}

func TestCreateJoinDetailGating(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	stranger := seedUser(t, db, "Stranger")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{}, seqCode())

	g, err := svc.Create(context.Background(), owner, "Squad")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	joined, err := svc.JoinByCode(context.Background(), member, g.InviteCode)
	require.NoError(t, err)
	require.Equal(t, g.ID, joined.ID)

	// member can view detail; stranger cannot
	d, err := svc.Detail(context.Background(), member, g.ID)
	require.NoError(t, err)
	require.Len(t, d.Members, 2)
	_, err = svc.Detail(context.Background(), stranger, g.ID)
	require.ErrorIs(t, err, ErrForbidden)

	// only owner can rename
	require.ErrorIs(t, svc.Rename(context.Background(), member, g.ID, "x"), ErrForbidden)
	require.NoError(t, svc.Rename(context.Background(), owner, g.ID, "Renamed"))

	// owner cannot leave while others remain; member can
	require.ErrorIs(t, svc.Leave(context.Background(), owner, g.ID), ErrOwnerCannotLeave)
	require.NoError(t, svc.Leave(context.Background(), member, g.ID))
}

func TestInviteRequiresFriendship(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	friend := seedUser(t, db, "Friend")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{pairs: map[[2]uuid.UUID]bool{{owner, friend}: true}}, seqCode())

	g, err := svc.Create(context.Background(), owner, "Squad")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", g.ID) })

	// inviting a non-friend fails; inviting a friend adds them
	require.ErrorIs(t, svc.InviteFriend(context.Background(), owner, g.ID, uuid.New()), ErrNotFriends)
	require.NoError(t, svc.InviteFriend(context.Background(), owner, g.ID, friend))
	isM, err := repo.IsMember(context.Background(), g.ID, friend)
	require.NoError(t, err)
	require.True(t, isM)
}
