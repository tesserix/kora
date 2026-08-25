package share

import (
	"context"
	"encoding/json"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/access"
)

// kora#440. The member-side read path that makes Leave reachable.

func TestMembershipsListsCirclesYouWereAddedTo(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))
	require.NoError(t, repo.SetCategories(context.Background(), c.ID, []access.Category{access.CategoryBody}))

	got, err := repo.ListForMember(context.Background(), member)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, c.ID, got[0].CircleID)
	require.Equal(t, owner, got[0].Owner.ID)
	require.Equal(t, []access.Category{access.CategoryBody}, got[0].Categories)
}

// The privacy decision this endpoint owns, pinned as a test rather than left
// as prose: circle names are the OWNER's private labels, and a member seeing
// which bucket they were filed under exposes a judgement the owner never
// chose to share.
func TestMembershipsNeverCarriesTheCircleName(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Gym crew not Mum")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	got, err := repo.ListForMember(context.Background(), member)
	require.NoError(t, err)
	require.Len(t, got, 1)

	blob, err := json.Marshal(got[0])
	require.NoError(t, err)
	require.NotContains(t, string(blob), "Gym crew")

	// Key-set assertion rather than a substring scan: "display_name" contains
	// "name", so grepping the blob cannot tell a leaked circle name from the
	// owner's legitimately-projected display name.
	var keys map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(blob, &keys))
	got_keys := make([]string, 0, len(keys))
	for k := range keys {
		got_keys = append(got_keys, k)
	}
	sort.Strings(got_keys)
	require.Equal(t, []string{"categories", "circle_id", "owner"}, got_keys)
}

// Email is never projected, same rule as MemberView and social.FriendView.
func TestMembershipsNeverCarriesTheOwnersEmail(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	got, err := repo.ListForMember(context.Background(), member)
	require.NoError(t, err)
	blob, err := json.Marshal(got[0])
	require.NoError(t, err)
	require.NotContains(t, string(blob), "@")
	require.NotContains(t, string(blob), "email")
}

// Owning a circle is not being shared with. Listing your own circle here
// would offer a Leave action on something you should delete instead.
func TestMembershipsExcludesYourOwnCircles(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Mine")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, owner))

	got, err := repo.ListForMember(context.Background(), owner)
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestMembershipsIsEmptyForSomeoneInNoCircles(t *testing.T) {
	db := testDB(t)
	stranger := seedUser(t, db, "Stranger")
	got, err := NewRepository(db).ListForMember(context.Background(), stranger)
	require.NoError(t, err)
	require.Empty(t, got)
}

// The whole point: leaving actually removes you, so the row stops appearing.
func TestLeavingRemovesTheMembershipFromTheList(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))
	require.Len(t, mustList(t, repo, member), 1)

	require.NoError(t, svc.Leave(context.Background(), member, c.ID))
	require.Empty(t, mustList(t, repo, member))
}

// One member leaving must not remove anyone else.
func TestLeavingDoesNotAffectOtherMembers(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	quitter := seedUser(t, db, "Quitter")
	stayer := seedUser(t, db, "Stayer")
	repo := NewRepository(db)
	svc := NewService(repo, stubFriends{areFriends: true})

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, quitter))
	require.NoError(t, repo.AddMember(context.Background(), c.ID, stayer))

	require.NoError(t, svc.Leave(context.Background(), quitter, c.ID))
	require.Empty(t, mustList(t, repo, quitter))
	require.Len(t, mustList(t, repo, stayer), 1)
}

func mustList(t *testing.T, repo Repository, id uuid.UUID) []MembershipView {
	t.Helper()
	got, err := repo.ListForMember(context.Background(), id)
	require.NoError(t, err)
	return got
}
