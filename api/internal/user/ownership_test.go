package user

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedUser provisions a user row with a unique firebase_uid via the
// established EnsureUser/UpsertByFirebaseUID path (fills all the NOT NULL
// defaults), and registers cleanup for the row it created.
func seedUser(t *testing.T, db *gorm.DB) User {
	t.Helper()
	fuid := fmt.Sprintf("ownership-test-%s", uuid.NewString())
	repo := NewRepository(db)
	u, err := repo.UpsertByFirebaseUID(context.Background(), fuid, fuid+"@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE firebase_uid = ?", fuid)
	})
	return u
}

// seededGroup is a minimal stand-in for groups.Group. The user package
// cannot import internal/groups here: groups already imports internal/user
// (for handler.go), and this file lives in package user (not user_test), so
// importing groups back would create an import cycle. Raw SQL sidesteps it.
type seededGroup struct {
	ID uuid.UUID
}

// seedGroup inserts a group owned by ownerID with a unique invite_code
// (required, no DB default). Deleting the owning user cascades away the
// group via groups.owner_id -> users(id) ON DELETE CASCADE, so no separate
// cleanup is registered here.
func seedGroup(t *testing.T, db *gorm.DB, ownerID uuid.UUID) seededGroup {
	t.Helper()
	g := seededGroup{ID: uuid.New()}
	err := db.Exec(
		`INSERT INTO groups (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)`,
		g.ID, "Ownership Test Group", ownerID, uuid.NewString(),
	).Error
	require.NoError(t, err)
	return g
}

// seedMember inserts a group_members row with an explicit joined_at. GORM's
// autoCreateTime tag on GroupMember.JoinedAt overwrites any value supplied
// via db.Create, so this uses a raw INSERT to make sure the caller-supplied
// timestamp is actually persisted -- the tests depend on ordering by it.
// Deleting the member's user row cascades away this row (group_members.user_id
// -> users(id)), so no separate cleanup is registered here.
func seedMember(t *testing.T, db *gorm.DB, groupID, userID uuid.UUID, joinedAt time.Time) {
	t.Helper()
	err := db.Exec(
		`INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
		groupID, userID, "member", joinedAt,
	).Error
	require.NoError(t, err)
}

func TestTransferOwnershipPassesToEarliestJoiner(t *testing.T) {
	db := testDB(t)
	owner, early, late := seedUser(t, db), seedUser(t, db), seedUser(t, db)
	g := seedGroup(t, db, owner.ID)
	seedMember(t, db, g.ID, late.ID, time.Now())
	seedMember(t, db, g.ID, early.ID, time.Now().Add(-48*time.Hour))

	transfers, err := transferOwnership(db, owner.ID)
	require.NoError(t, err)
	require.Len(t, transfers, 1)
	assert.Equal(t, early.ID, transfers[0].NewOwnerID, "earliest joined_at inherits")

	var got uuid.UUID
	require.NoError(t, db.Raw(`SELECT owner_id FROM groups WHERE id = ?`, g.ID).Row().Scan(&got))
	assert.Equal(t, early.ID, got)
}

// TestTransfersSerialiseAsEmptyArrayNotNull asserts on the SERIALISED body,
// not the Go slice, because that is the only place the bug is visible: a nil
// []Transfer and an empty one are both len 0 in Go, but encoding/json writes
// the first as `null` and the second as `[]`.
//
// The portal's runtime type guards (tesserix-home, lib/api/kora-admin.ts)
// require Array.isArray(transfers), and Array.isArray(null) is false. A nil
// here therefore turns a perfectly good 200 into "unexpected_response_shape"
// for any user who owns no multi-member group -- which is most of them. On
// the DELETE path that is worse than a broken panel: the account IS gone and
// the transaction HAS committed, while the operator is told an irreversible
// destruction failed and a retry answers 404.
//
// Both payloads that carry transfers are covered here, since both are fed by
// the same previewTransfers/transferOwnership pair.
func TestTransfersSerialiseAsEmptyArrayNotNull(t *testing.T) {
	db := testDB(t)
	u := seedUser(t, db) // owns no groups at all, so the SELECT matches no rows

	detail, err := NewRepository(db).GetForAdmin(context.Background(), u.ID)
	require.NoError(t, err)
	detailBody, err := json.Marshal(detail)
	require.NoError(t, err)
	assert.Contains(t, string(detailBody), `"transfers":[]`, "AdminDetail must serialise an empty array")
	assert.NotContains(t, string(detailBody), `"transfers":null`, "a nil slice breaks the portal's detail panel")

	res, err := newTestService(t, db).Delete(context.Background(), u.ID, DeleteActor{})
	require.NoError(t, err)
	deleteBody, err := json.Marshal(res)
	require.NoError(t, err)
	assert.Contains(t, string(deleteBody), `"transfers":[]`, "DeleteResult must serialise an empty array")
	assert.NotContains(t, string(deleteBody), `"transfers":null`,
		"a nil slice makes the portal report a committed, irreversible deletion as a failure")
}

func TestTransferOwnershipLeavesSoloGroupToCascade(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db)
	g := seedGroup(t, db, owner.ID)

	transfers, err := transferOwnership(db, owner.ID)
	require.NoError(t, err)
	assert.Empty(t, transfers, "a solo group is not transferred; it cascades")

	var stillOwned uuid.UUID
	require.NoError(t, db.Raw(`SELECT owner_id FROM groups WHERE id = ?`, g.ID).Row().Scan(&stillOwned))
	assert.Equal(t, owner.ID, stillOwned, "untouched, so the cascade removes it")
}
