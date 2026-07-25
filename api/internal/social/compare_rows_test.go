package social

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestListAcceptedForCompareCarriesShareAndTarget(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	sharer := seedUser(t, db, "Sharer")
	private := seedUser(t, db, "Private")
	require.NoError(t, db.Exec("UPDATE users SET share_progress = true, target_kcal = 2100 WHERE id = ?", sharer).Error)
	require.NoError(t, db.Exec("UPDATE users SET share_progress = false, target_kcal = 1800 WHERE id = ?", private).Error)

	repo := NewRepository(db)
	_, err := repo.Create(context.Background(), Friendship{RequesterID: me, AddresseeID: sharer, Status: FriendStatusAccepted})
	require.NoError(t, err)
	_, err = repo.Create(context.Background(), Friendship{RequesterID: private, AddresseeID: me, Status: FriendStatusAccepted})
	require.NoError(t, err)

	rows, err := repo.ListAcceptedForCompare(context.Background(), me)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	byName := map[string]CompareRow{}
	for _, r := range rows {
		byName[r.DisplayName] = r
	}
	require.True(t, byName["Sharer"].ShareProgress)
	require.Equal(t, 2100.0, byName["Sharer"].TargetKcal)
	require.False(t, byName["Private"].ShareProgress)
}
