package identity

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newSvc(db *gorm.DB) Service {
	// A stand-in URL composer: Task 7 supplies the real one from assets.Store.
	return NewService(NewRepository(db), func(path string) string {
		if path == "" {
			return ""
		}
		return "https://assets.test/" + path
	})
}

// retireCleanup removes the retired_handles rows a test created, computing the
// canonical form with Canonical() rather than hand-writing the folded spelling.
// Hand-written folded literals are how this suite broke: a cleanup targeting
// 'dropped' never matched the row actually written, which is 'dr0pped', so a
// stray retirement survived and failed the NEXT run with ErrHandleRetired.
// One implementation of the fold, no drift -- the same reasoning as reservedNames.
func retireCleanup(t *testing.T, db *gorm.DB, raws ...string) {
	t.Helper()
	t.Cleanup(func() {
		for _, raw := range raws {
			_, canonical, err := Canonical(raw)
			if err != nil {
				t.Errorf("retireCleanup: %q is not a valid handle: %v", raw, err)
				continue
			}
			db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, canonical)
		}
	})
}

func TestClaim_ThenLookupFindsIt(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	retireCleanup(t, db, "ada")

	display, err := svc.Claim(context.Background(), id, "@AdA")
	require.NoError(t, err)
	require.Equal(t, "ada", display)

	got, err := svc.Lookup(context.Background(), "ada")
	require.NoError(t, err)
	require.Equal(t, id, got.ID)
	require.Equal(t, "ada", got.Handle)
	require.Equal(t, "Test Person", got.DisplayName)
}

// Folding on lookup is what makes a handle heard correctly always resolve.
func TestLookup_FoldsConfusables(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	h := "ada_l"
	retireCleanup(t, db, h)

	_, err := svc.Claim(context.Background(), id, h)
	require.NoError(t, err)

	for _, spoken := range []string{"ada_l", "ada_1", "ada_i", "ADA_L", "@ada_1"} {
		got, err := svc.Lookup(context.Background(), spoken)
		require.NoError(t, err, "spoken form %q must resolve", spoken)
		require.Equal(t, id, got.ID)
		require.Equal(t, "ada_l", got.Handle, "the DISPLAY form is returned, not the folded one")
	}
}

func TestLookup_MissIsNotFound(t *testing.T) {
	db := testDB(t)
	_, err := newSvc(db).Lookup(context.Background(), "nobody_here_at_all")
	require.ErrorIs(t, err, ErrNotFound)
}

// A handle that could never have been claimed is still a miss, not a 400.
// The caller typed something; the answer is "no such person" either way.
func TestLookup_InvalidShapeIsNotFound(t *testing.T) {
	db := testDB(t)
	_, err := newSvc(db).Lookup(context.Background(), "no")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestClaim_TakenByAnotherUser(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	retireCleanup(t, db, "takenl")

	_, err := svc.Claim(context.Background(), a, "takenl")
	require.NoError(t, err)

	// The confusable twin, from a different account.
	_, err = svc.Claim(context.Background(), b, "taken1")
	require.ErrorIs(t, err, ErrHandleTaken)
}

// Re-claiming your OWN handle is a no-op, not a conflict. Otherwise saving a
// profile form twice reads as "that handle is taken" — by yourself.
func TestClaim_SameHandleAgainIsFine(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	retireCleanup(t, db, "stable")

	_, err := svc.Claim(context.Background(), id, "stable")
	require.NoError(t, err)
	_, err = svc.Claim(context.Background(), id, "stable")
	require.NoError(t, err)

	_, canonical, err := Canonical("stable")
	require.NoError(t, err)

	var n int64
	require.NoError(t, db.Raw(
		`SELECT count(*) FROM retired_handles WHERE handle_canonical = ?`, canonical).Scan(&n).Error)
	require.EqualValues(t, 0, n, "re-claiming your own handle must not retire it")
}

func TestClaim_ChangingRetiresTheOldOneAndFreesNothing(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	retireCleanup(t, db, "oldname", "newname")

	_, err := svc.Claim(context.Background(), a, "oldname")
	require.NoError(t, err)
	_, err = svc.Claim(context.Background(), a, "newname")
	require.NoError(t, err)

	// The old handle is gone from the user...
	_, err = svc.Lookup(context.Background(), "oldname")
	require.ErrorIs(t, err, ErrNotFound)
	// ...and nobody else can have it. Not even the person who released it.
	_, err = svc.Claim(context.Background(), b, "oldname")
	require.ErrorIs(t, err, ErrHandleRetired)
	_, err = svc.Claim(context.Background(), a, "oldname")
	require.ErrorIs(t, err, ErrHandleRetired)
}

func TestClear_RetiresTheHandle(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	a, b := seedUser(t, db), seedUser(t, db)
	retireCleanup(t, db, "dropped")

	_, err := svc.Claim(context.Background(), a, "dropped")
	require.NoError(t, err)
	require.NoError(t, svc.Clear(context.Background(), a))

	_, err = svc.Lookup(context.Background(), "dropped")
	require.ErrorIs(t, err, ErrNotFound)
	_, err = svc.Claim(context.Background(), b, "dropped")
	require.ErrorIs(t, err, ErrHandleRetired)
}

func TestClear_WithNoHandleIsANoOp(t *testing.T) {
	db := testDB(t)
	require.NoError(t, newSvc(db).Clear(context.Background(), seedUser(t, db)))
}

func TestClaim_RejectsReservedAndInvalid(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	_, err := svc.Claim(context.Background(), id, "support")
	require.ErrorIs(t, err, ErrHandleReserved)
	_, err = svc.Claim(context.Background(), id, "no")
	require.ErrorIs(t, err, ErrHandleInvalid)
}

// The projection rule that share.MemberView and social.FriendView already
// follow, restated where it is easiest to break.
func TestLookupView_HasNoEmailField(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	retireCleanup(t, db, "private")
	_, err := svc.Claim(context.Background(), id, "private")
	require.NoError(t, err)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, id).Scan(&email).Error)
	require.NotEmpty(t, email)

	got, err := svc.Lookup(context.Background(), "private")
	require.NoError(t, err)
	body, err := json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(body), email)
	require.NotContains(t, string(body), "email")
}

func TestLookup_ComposesAvatarURLFromPath(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	retireCleanup(t, db, "withpic")
	_, err := svc.Claim(context.Background(), id, "withpic")
	require.NoError(t, err)
	require.NoError(t, db.Exec(
		`UPDATE users SET avatar_path = ? WHERE id = ?`, "avatars/"+id.String()+"/v1.jpg", id).Error)

	got, err := svc.Lookup(context.Background(), "withpic")
	require.NoError(t, err)
	require.Equal(t, "https://assets.test/avatars/"+id.String()+"/v1.jpg", got.AvatarURL)
}

// No picture is an empty string, never a broken URL. The client falls back to
// initials on empty; a "https://assets.test/" pointing at nothing renders as a
// broken image inside a friend row.
func TestLookup_NoAvatarIsEmptyURL(t *testing.T) {
	db := testDB(t)
	svc := newSvc(db)
	id := seedUser(t, db)
	retireCleanup(t, db, "nopic")
	_, err := svc.Claim(context.Background(), id, "nopic")
	require.NoError(t, err)

	got, err := svc.Lookup(context.Background(), "nopic")
	require.NoError(t, err)
	require.Empty(t, got.AvatarURL)
}
