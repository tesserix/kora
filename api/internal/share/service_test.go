package share

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
)

type stubFriends struct{ areFriends bool }

func (s stubFriends) AreFriends(ctx context.Context, a, b uuid.UUID) (bool, error) {
	return s.areFriends, nil
}

func TestAddMemberRefusesANonFriend(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: false})
	owner := seedUser(t, db, "owner")
	stranger := seedUser(t, db, "stranger")
	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)

	err = svc.AddMember(context.Background(), owner, c.ID, stranger)
	require.ErrorIs(t, err, ErrNotFriends)
}

func TestAddMemberAcceptsAFriend(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	friend := seedUser(t, db, "friend")
	c, _ := repo.Create(context.Background(), owner, "Household")

	require.NoError(t, svc.AddMember(context.Background(), owner, c.ID, friend))

	views, err := repo.ListForOwner(context.Background(), owner)
	require.NoError(t, err)
	require.Len(t, views[0].Members, 1)
	require.Equal(t, friend, views[0].Members[0].ID)
}

// Every mutation is owner-gated. Without this, knowing a circle UUID would be
// enough to grant yourself access to its owner's data.
func TestMutationsRefuseANonOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	attacker := seedUser(t, db, "attacker")
	victimCircle, _ := repo.Create(context.Background(), owner, "Household")

	require.ErrorIs(t, svc.AddMember(context.Background(), attacker, victimCircle.ID, attacker), ErrNotOwner)
	require.ErrorIs(t, svc.RemoveMember(context.Background(), attacker, victimCircle.ID, owner), ErrNotOwner)
	require.ErrorIs(t, svc.SetCategories(context.Background(), attacker, victimCircle.ID,
		[]access.Category{access.CategoryBody}), ErrNotOwner)
	require.ErrorIs(t, svc.Delete(context.Background(), attacker, victimCircle.ID), ErrNotOwner)
}

// TestCreateRejectsAWhitespaceOnlyName pins the fix for a name that is only
// whitespace: len(name) measures bytes and previously ran BEFORE the
// repository's strings.TrimSpace, so "   " passed validation, trimmed to "",
// and tripped share_circles_name_not_blank as an unmapped 23514 -> 500.
// Validation must trim first, so this is rejected as a 400 here instead.
func TestCreateRejectsAWhitespaceOnlyName(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")

	_, err := svc.Create(context.Background(), owner, "   ")
	var valErr httpx.ValidationError
	require.ErrorAs(t, err, &valErr)
}

func TestSetCategoriesRefusesAnUnknownCategory(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	c, _ := repo.Create(context.Background(), owner, "Household")

	err := svc.SetCategories(context.Background(), owner, c.ID, []access.Category{"recipes"})
	var valErr httpx.ValidationError
	require.ErrorAs(t, err, &valErr)
}

// A member may remove themselves. Being shared with carries an implicit
// relationship and possibly notifications, and is not always welcome.
func TestAMemberMayLeaveACircleTheyDoNotOwn(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db, func(string) string { return "" })
	svc := NewService(repo, stubFriends{areFriends: true})
	owner := seedUser(t, db, "owner")
	member := seedUser(t, db, "member")
	c, _ := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	require.NoError(t, svc.Leave(context.Background(), member, c.ID))

	views, _ := repo.ListForOwner(context.Background(), owner)
	require.Empty(t, views[0].Members)
}
