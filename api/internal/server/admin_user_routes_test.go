package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/admin"
)

// The admin user surface must be mounted and protected: 401 for an unsigned
// request, never 404 (never mounted, so the test would pass for the wrong
// reason) and emphatically never 200. The DELETE matters most — a
// mounted-but-open admin delete destroys an account irreversibly.
//
// Uses a bare &gorm.DB{}: bffauth rejects before any handler runs, so this
// assertion cannot SKIP itself if TEST_DATABASE_URL goes missing.
func TestAdminUserRoutesRejectUnsignedRequests(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}, BFFHMACKey: []byte(adminTestKey)})
	id := uuid.New().String()

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/v1/admin/users"},
		{http.MethodGet, "/v1/admin/users/" + id},
		{http.MethodDelete, "/v1/admin/users/" + id},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		assert.Equal(t, http.StatusUnauthorized, w.Code, "%s %s", tc.method, tc.path)
	}
}

// With no HMAC key configured the destructive route must not exist at all:
// 404, not 401. Same choice the food mutation surface makes.
func TestAdminUserRoutesAreUnmountedWithoutAKey(t *testing.T) {
	r := NewRouter(Deps{DB: &gorm.DB{}, Verifier: stubVerifier{}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/v1/admin/users/"+uuid.New().String(), nil))
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestAdminUserDeleteUnknownIs404ThroughTheRouter(t *testing.T) {
	key := []byte(adminTestKey)
	r := NewRouter(Deps{DB: testDB(t), Verifier: stubVerifier{}, BFFHMACKey: key})

	path := "/v1/admin/users/" + uuid.New().String()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, path, ""))

	require.NotEqual(t, http.StatusUnauthorized, w.Code, "a signed, well-formed UUID path must verify")
	assert.Equal(t, http.StatusNotFound, w.Code, "a random UUID is not a user that exists")
}

// *** THE TEST THAT PINS THE AUDIT CONSTANTS ***
//
// internal/user CANNOT import internal/admin (admin -> ai -> nutrition ->
// user is an import cycle), so its own deletion tests hardcode the SQL
// literals 'user.deleted' and 'user' in testAuditRecorder. Nothing in that
// package can prove those literals match the REAL constants, and the closure
// that carries them into production — auditDeletion, in this file's package —
// is only reached through the router.
//
// This package can import both, so this test runs a real signed DELETE
// through the real router and reads the kora_admin_events row's ACTION and
// TARGET_TYPE columns back, asserting them against admin.ActionUserDeleted
// and admin.TargetTypeUser rather than string literals. Without it, a rename
// of either constant would leave internal/user green and the production audit
// trail silently writing a value nothing reads.
//
// It also pins the 200-with-body divergence from DELETE /v1/me's bare 204:
// with no IdentityDeleter wired, unwiredIdentityDeleter errors, the Firebase
// identity survives, and the operator must be TOLD — an admin has no
// self-healing retry through the user, so a surviving identity means the
// person they deleted can sign in and be re-provisioned by EnsureUser.
func TestAdminUserDeleteWritesTheRealAuditConstants(t *testing.T) {
	db := testDB(t)
	key := []byte(adminTestKey)
	victim := seedRouteUser(t, db, "admin-delete-victim-"+uuid.NewString())
	survivor := seedRouteUser(t, db, "admin-delete-survivor-"+uuid.NewString())
	// kora_admin_events deliberately OUTLIVES the user it describes, so the
	// users cascade does not carry it away.
	t.Cleanup(func() { db.Exec(`DELETE FROM kora_admin_events WHERE target_id = ?`, victim.ID) })

	// No IdentityDeleter wired on purpose: unwiredIdentityDeleter reports the
	// identity as surviving, which is the state the body must disclose.
	r := NewRouter(Deps{DB: db, Verifier: stubVerifier{}, BFFHMACKey: key})

	path := "/v1/admin/users/" + victim.ID.String()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodDelete, path, ""))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), `"firebase_identity_removed":false`,
		"an admin has no retry through the user, so a surviving identity must be reported")

	assert.Zero(t, countRouteUsers(t, db, victim.ID), "the targeted row must actually be gone")
	assert.Equal(t, int64(1), countRouteUsers(t, db, survivor.ID), "only the target may be deleted")

	var action, targetType, actorID, actorEmail string
	require.NoError(t, db.Raw(`
		SELECT action, target_type, actor_id, actor_email
		FROM kora_admin_events WHERE target_id = ?`, victim.ID).
		Row().Scan(&action, &targetType, &actorID, &actorEmail),
		"an admin deletion must leave exactly one audit row")

	// Asserted against the CONSTANTS: this is the only place the value the
	// production path actually writes is compared to admin's own vocabulary.
	// A closure that passed some other action would fail here.
	assert.Equal(t, admin.ActionUserDeleted, action)
	assert.Equal(t, admin.TargetTypeUser, targetType)

	// The second half of the link, and the reason this test is not circular:
	// internal/user's testAuditRecorder hardcodes these two SQL LITERALS
	// because that package cannot import internal/admin. Renaming a constant
	// would keep the two assertions above green while silently leaving those
	// fixtures writing a value nothing reads. These pin the literals to the
	// constants, in the one package that can see both.
	assert.Equal(t, "user.deleted", admin.ActionUserDeleted,
		"internal/user's testAuditRecorder hardcodes this literal")
	assert.Equal(t, "user", admin.TargetTypeUser,
		"internal/user's testAuditRecorder hardcodes this literal")
	assert.Equal(t, adminTestIdentity().UserID, actorID, "the bffauth identity must reach the audit row")
	assert.Equal(t, adminTestIdentity().Email, actorEmail)
}

// The detail read, end to end. Asserts only that a signed request reaches the
// handler and answers about the seeded user — never a global count.
func TestAdminUserDetailIsReachableWithAValidSignature(t *testing.T) {
	db := testDB(t)
	key := []byte(adminTestKey)
	u := seedRouteUser(t, db, "admin-detail-"+uuid.NewString())

	r := NewRouter(Deps{DB: db, Verifier: stubVerifier{}, BFFHMACKey: key})

	path := "/v1/admin/users/" + u.ID.String()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, signedAdminRequest(t, key, http.MethodGet, path, ""))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), `"counts"`)
	assert.NotContains(t, w.Body.String(), "firebase_uid")
	assert.NotContains(t, w.Body.String(), "apple_refresh_token")
}
