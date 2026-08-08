package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/user"
)

// uidVerifier authenticates every request as one fixed Firebase uid.
// stubVerifier cannot be reused here: it returns empty Claims, so
// ResolveMiddleware would reject with 401 before any handler ran and this
// test would pass for the wrong reason.
type uidVerifier struct{ uid string }

func (v uidVerifier) Verify(context.Context, string) (auth.Claims, error) {
	return auth.Claims{UID: v.uid, Email: v.uid + "@test.dev"}, nil
}

// recordingIdentityDeleter stands in for the Firebase Admin client. It also
// proves the wiring reached the Service: the uid it records can only have
// come off the users row that Delete loaded before destroying it.
type recordingIdentityDeleter struct{ uids []string }

func (d *recordingIdentityDeleter) DeleteIdentity(_ context.Context, firebaseUID string) error {
	d.uids = append(d.uids, firebaseUID)
	return nil
}

func seedRouteUser(t *testing.T, db *gorm.DB, uid string) user.User {
	t.Helper()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", uid) })
	u, err := user.NewRepository(db).UpsertByFirebaseUID(context.Background(), uid, uid+"@test.dev")
	require.NoError(t, err)
	return u
}

func countRouteUsers(t *testing.T, db *gorm.DB, id uuid.UUID) int64 {
	t.Helper()
	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, id).Scan(&n).Error)
	return n
}

// Route registration on its own, with a bare &gorm.DB{}: this assertion must
// not be able to SKIP itself if TEST_DATABASE_URL goes missing. An unmounted
// DELETE /v1/me is a rejected App Store submission under a green build.
func TestDeleteMeRouteIsRegistered(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	assert.True(t, hasRoute(r.Routes(), http.MethodDelete, "/v1/me"),
		"DELETE /v1/me must be mounted — it is the server half of Apple's in-app account deletion requirement")
}

// The end-to-end proof: a real request through the real router, against a
// real database, removes the caller's row and nobody else's. The 204 alone
// proves only that the handler returned, so the row count is what is
// actually asserted.
func TestDeleteMeThroughTheRouterDeletesOnlyTheCaller(t *testing.T) {
	db := testDB(t)
	victim := seedRouteUser(t, db, "delete-me-victim-"+uuid.NewString())
	survivor := seedRouteUser(t, db, "delete-me-survivor-"+uuid.NewString())

	fb := &recordingIdentityDeleter{}
	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: victim.FirebaseUID}, IdentityDeleter: fb})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Zero(t, countRouteUsers(t, db, victim.ID), "the caller's row must actually be gone")
	assert.Equal(t, int64(1), countRouteUsers(t, db, survivor.ID), "only the caller may be deleted")
	assert.Equal(t, []string{victim.FirebaseUID}, fb.uids,
		"the wired IdentityDeleter must be called with the deleted row's firebase uid")
}

// An unwired IdentityDeleter must not panic the request: the DB delete has
// already committed by the time the identity step runs, so a nil dependency
// there would turn a completed deletion into a 500 and a stack trace.
func TestDeleteMeSurvivesAnUnwiredIdentityDeleter(t *testing.T) {
	db := testDB(t)
	victim := seedRouteUser(t, db, "delete-me-unwired-"+uuid.NewString())

	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: victim.FirebaseUID}}) // no IdentityDeleter

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Zero(t, countRouteUsers(t, db, victim.ID))
}
