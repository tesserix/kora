package access

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// This asserts what .Distinct("c.owner_id") in GrantedOwners actually
// controls: the repository's own return value has one element per owner, not
// one per (owner, granting circle) join row. TestResolveManyDeduplicatesOverlappingCircles
// exercises the same fixture through Service.ResolveMany, but that map write
// (out[owner] = Grant{...}) collapses duplicate owner rows for free, so it
// would pass even if DISTINCT were removed. This test calls the repository
// directly so DISTINCT has nowhere to hide.
func TestGrantedOwnersDeduplicatesAcrossCircles(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	viewer := seedUser(t, db, "viewer")
	owner := seedUser(t, db, "owner")
	seedCircle(t, db, owner, "Household", []uuid.UUID{viewer}, []Category{CategoryProgress})
	seedCircle(t, db, owner, "Gym", []uuid.UUID{viewer}, []Category{CategoryProgress})

	got, err := repo.GrantedOwners(context.Background(), viewer, []uuid.UUID{owner}, CategoryProgress)
	require.NoError(t, err)
	require.Equal(t, []uuid.UUID{owner}, got)
}
