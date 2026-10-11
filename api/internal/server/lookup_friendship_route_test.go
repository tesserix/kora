package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/identity"
	"github.com/tesserix/kora/api/internal/user"
)

// The end-to-end proof for kora#453: a real request, through the REAL
// router, wiring the REAL social.Service into identity.Service.WithFriendships
// (internal/server/router.go), against a real database. The handler-level
// tests in internal/identity build their own gin.Engine with no social.Service
// at all -- that proves Lookup degrades correctly with nothing wired, not
// that production actually wires the two together, and a router.go that lost
// the WithFriendships(socialSvc) call would not show up there.

// seedLookupUser mirrors seedBodyUser (friend_body_route_test.go) -- its own
// copy because that file's cleanup also drops weight_entries, which does not
// exist for these fixtures.
func seedLookupUser(t *testing.T, db *gorm.DB, uid string) user.User {
	t.Helper()
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", uid) })
	u, err := user.NewRepository(db).UpsertByFirebaseUID(context.Background(), uid, uid+"@test.dev")
	require.NoError(t, err)
	return u
}

// claimLookupHandle claims raw for userID through the real identity.Service,
// the same one router.go wires -- never hand-writing handle_canonical, per
// the standing rule that broke this suite once before.
func claimLookupHandle(t *testing.T, db *gorm.DB, userID uuid.UUID, raw string) {
	t.Helper()
	svc := identity.NewService(identity.NewRepository(db), func(string) string { return "" })
	_, err := svc.Claim(context.Background(), userID, raw)
	require.NoError(t, err)
}

func lookupThroughRouter(t *testing.T, db *gorm.DB, as user.User, handle string) *httptest.ResponseRecorder {
	t.Helper()
	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: as.FirebaseUID}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/users/lookup?handle="+handle, nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	return w
}

func sendRequestThroughRouter(t *testing.T, db *gorm.DB, as user.User, targetHandle string) *httptest.ResponseRecorder {
	t.Helper()
	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: as.FirebaseUID}})
	w := httptest.NewRecorder()
	body := `{"handle":"` + targetHandle + `"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/friends/requests", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func acceptRequestThroughRouter(t *testing.T, db *gorm.DB, as user.User, requestID uuid.UUID) *httptest.ResponseRecorder {
	t.Helper()
	r := NewRouter(Deps{DB: db, Verifier: uidVerifier{uid: as.FirebaseUID}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/friends/requests/"+requestID.String()+"/accept", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	return w
}

func lookupFriendshipStatus(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var env struct {
		Data struct {
			FriendshipStatus string `json:"friendship_status"`
			ID               string `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &env))
	return env.Data.FriendshipStatus
}

// TestLookupThroughTheRouter_NoneWhenNoRelationship covers the default case:
// two strangers, no friendship row of any shape.
func TestLookupThroughTheRouter_NoneWhenNoRelationship(t *testing.T) {
	db := testDB(t)
	viewer := seedLookupUser(t, db, "lk-none-viewer-"+uuid.NewString())
	target := seedLookupUser(t, db, "lk-none-target-"+uuid.NewString())
	claimLookupHandle(t, db, target.ID, "lknonetarget")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lknonetarget") })

	w := lookupThroughRouter(t, db, viewer, "lknonetarget")
	require.Equal(t, "none", lookupFriendshipStatus(t, w))
}

// TestLookupThroughTheRouter_RequestSentWhenViewerAlreadyAsked covers the
// state that motivated kora#453: the viewer already sent this exact person a
// request, so the button must not offer to send another.
func TestLookupThroughTheRouter_RequestSentWhenViewerAlreadyAsked(t *testing.T) {
	db := testDB(t)
	viewer := seedLookupUser(t, db, "lk-sent-viewer-"+uuid.NewString())
	target := seedLookupUser(t, db, "lk-sent-target-"+uuid.NewString())
	claimLookupHandle(t, db, target.ID, "lksenttarget")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lksenttarget") })

	sr := sendRequestThroughRouter(t, db, viewer, "lksenttarget")
	require.Equal(t, http.StatusCreated, sr.Code, sr.Body.String())

	w := lookupThroughRouter(t, db, viewer, "lksenttarget")
	require.Equal(t, "request_sent", lookupFriendshipStatus(t, w))
}

// TestLookupThroughTheRouter_RequestReceivedWhenTargetAlreadyAsked is the
// mirror: the person the viewer is looking up already sent THEM a request.
// "Send request" would be accepted outright (SendRequest is idempotent), but
// the button should say "Respond", not "Send".
func TestLookupThroughTheRouter_RequestReceivedWhenTargetAlreadyAsked(t *testing.T) {
	db := testDB(t)
	viewer := seedLookupUser(t, db, "lk-recv-viewer-"+uuid.NewString())
	target := seedLookupUser(t, db, "lk-recv-target-"+uuid.NewString())
	claimLookupHandle(t, db, viewer.ID, "lkrecvviewer")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lkrecvviewer") })

	// target sends viewer a request.
	sr := sendRequestThroughRouter(t, db, target, "lkrecvviewer")
	require.Equal(t, http.StatusCreated, sr.Code, sr.Body.String())

	// viewer looks target up by their firebase-derived handle... but target
	// has none claimed, so look up by email instead is not possible (Lookup
	// is handle-only). Claim one for target too.
	claimLookupHandle(t, db, target.ID, "lkrecvtarget")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lkrecvtarget") })

	w := lookupThroughRouter(t, db, viewer, "lkrecvtarget")
	require.Equal(t, "request_received", lookupFriendshipStatus(t, w))
}

// TestLookupThroughTheRouter_FriendsWhenAccepted covers the state kora#453
// exists for: the button must say "Already friends", not offer a live send.
func TestLookupThroughTheRouter_FriendsWhenAccepted(t *testing.T) {
	db := testDB(t)
	viewer := seedLookupUser(t, db, "lk-friends-viewer-"+uuid.NewString())
	target := seedLookupUser(t, db, "lk-friends-target-"+uuid.NewString())
	claimLookupHandle(t, db, target.ID, "lkfriendstarget")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lkfriendstarget") })

	sr := sendRequestThroughRouter(t, db, viewer, "lkfriendstarget")
	require.Equal(t, http.StatusCreated, sr.Code, sr.Body.String())
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(sr.Body.Bytes(), &created))
	requestID, err := uuid.Parse(created.Data.ID)
	require.NoError(t, err)

	ar := acceptRequestThroughRouter(t, db, target, requestID)
	require.Equal(t, http.StatusOK, ar.Code, ar.Body.String())

	w := lookupThroughRouter(t, db, viewer, "lkfriendstarget")
	require.Equal(t, "friends", lookupFriendshipStatus(t, w))
}

// TestLookupThroughTheRouter_SelfLookupIsNeitherNoneNorFriends: looking
// yourself up must not read as "you could send yourself a request" (none) or
// "you and you are friends" (friends) -- it gets its own value.
func TestLookupThroughTheRouter_SelfLookupIsNeitherNoneNorFriends(t *testing.T) {
	db := testDB(t)
	me := seedLookupUser(t, db, "lk-self-"+uuid.NewString())
	claimLookupHandle(t, db, me.ID, "lkselfhandle")
	t.Cleanup(func() { db.Exec(`DELETE FROM retired_handles WHERE handle_canonical = ?`, "lkselfhandle") })

	w := lookupThroughRouter(t, db, me, "lkselfhandle")
	require.Equal(t, "self", lookupFriendshipStatus(t, w))
}
