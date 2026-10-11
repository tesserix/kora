package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/user"
)

// The end-to-end proof for kora#438: a real request, through the REAL router
// and its real auth + ResolveMiddleware, against a real database.
//
// The handler-level tests in internal/tracking build their own gin.Engine
// and set user_id directly. That proves the handler behaves; it cannot prove
// production mounts it behind the middleware that supplies the viewer, and a
// grant check reading the wrong viewer is precisely the bug that would not
// show up there.

func seedBodyUser(t *testing.T, db *gorm.DB, uid string) user.User {
	t.Helper()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", uid) })
	u, err := user.NewRepository(db).UpsertByFirebaseUID(context.Background(), uid, uid+"@test.dev")
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM weight_entries WHERE user_id = ?", u.ID) })
	return u
}

// seedBodyGrant puts viewer in a circle owned by owner that grants category.
func seedBodyGrant(t *testing.T, db *gorm.DB, viewer, owner uuid.UUID, category access.Category) {
	t.Helper()
	circleID := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)`,
		circleID, owner, "circle-"+circleID.String()).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)`,
		circleID, viewer).Error)
	require.NoError(t, db.Exec(
		`INSERT INTO share_grants (circle_id, category) VALUES (?, ?)`,
		circleID, string(category)).Error)
	t.Cleanup(func() { db.Exec(`DELETE FROM share_circles WHERE id = ?`, circleID) })
}

// seedBodyWeighIn writes one weigh-in. Arbitrary fixtures; they describe
// nobody.
func seedBodyWeighIn(t *testing.T, db *gorm.DB, userID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (id, user_id, weight_kg, body_fat_pct, logged_at, local_date, source)
		 VALUES (gen_random_uuid(), ?, 70, 20, now() - interval '1 day', current_date - 1, 'manual')`,
		userID).Error)
}

func getBodyThroughRouter(t *testing.T, db *gorm.DB, viewer user.User, ownerID uuid.UUID) *httptest.ResponseRecorder {
	t.Helper()
	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: viewer.FirebaseUID}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/friends/"+ownerID.String()+"/body", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	return w
}

func TestFriendBodyThroughTheRouterServesAGrantedViewer(t *testing.T) {
	db := testDB(t)
	viewer := seedBodyUser(t, db, "fb-viewer-"+uuid.NewString())
	owner := seedBodyUser(t, db, "fb-owner-"+uuid.NewString())
	seedBodyWeighIn(t, db, owner.ID)
	seedBodyGrant(t, db, viewer.ID, owner.ID, access.CategoryBody)

	w := getBodyThroughRouter(t, db, viewer, owner.ID)

	require.Equal(t, http.StatusOK, w.Code)
	var env struct {
		Data []map[string]any `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &env))
	require.Len(t, env.Data, 1)
	require.Equal(t, 70.0, env.Data[0]["weight_kg"])
	require.Equal(t, 20.0, env.Data[0]["body_fat_pct"])
	require.NotContains(t, env.Data[0], "source", "metadata must not cross the grant")
}

// The direction of a grant. A circle belongs to its owner and exposes only
// that owner's data; being able to read someone never implies they can read
// you. Asserted through the router because this is the case a handler that
// mixed up viewer and owner would still pass its own unit tests on.
func TestFriendBodyThroughTheRouterIsNotReciprocal(t *testing.T) {
	db := testDB(t)
	viewer := seedBodyUser(t, db, "fb-oneway-viewer-"+uuid.NewString())
	owner := seedBodyUser(t, db, "fb-oneway-owner-"+uuid.NewString())
	seedBodyWeighIn(t, db, viewer.ID)
	seedBodyWeighIn(t, db, owner.ID)
	// owner shares with viewer, and only in that direction.
	seedBodyGrant(t, db, viewer.ID, owner.ID, access.CategoryBody)

	// The owner reading the viewer back gets nothing.
	w := getBodyThroughRouter(t, db, owner, viewer.ID)

	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
}

func TestFriendBodyThroughTheRouterIs404WithoutAGrant(t *testing.T) {
	db := testDB(t)
	viewer := seedBodyUser(t, db, "fb-nogrant-viewer-"+uuid.NewString())
	owner := seedBodyUser(t, db, "fb-nogrant-owner-"+uuid.NewString())
	seedBodyWeighIn(t, db, owner.ID)

	w := getBodyThroughRouter(t, db, viewer, owner.ID)

	require.Equal(t, http.StatusNotFound, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
	require.NotContains(t, w.Body.String(), "body_fat_pct")
}

// Unauthenticated callers never reach the grant check at all.
func TestFriendBodyThroughTheRouterRejectsAnUnauthenticatedCaller(t *testing.T) {
	db := testDB(t)
	owner := seedBodyUser(t, db, "fb-anon-owner-"+uuid.NewString())
	seedBodyWeighIn(t, db, owner.ID)

	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: "someone"}})
	w := httptest.NewRecorder()
	// No Authorization header.
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/friends/"+owner.ID.String()+"/body", nil))

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.NotContains(t, w.Body.String(), "weight_kg")
}
