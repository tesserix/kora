package user

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
)

type staticVerifier struct{ claims auth.Claims }

func (s staticVerifier) Verify(_ context.Context, _ string) (auth.Claims, error) {
	return s.claims, nil
}

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

func TestMeCreatesUserOnFirstCall(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-me") })

	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: "test-uid-me", Email: "me@test.dev"}}
	h := NewHandler(NewRepository(db), Service{})
	r.GET("/v1/me", auth.Middleware(v), h.Me)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"email":"me@test.dev"`)

	var count int64
	db.Model(&User{}).Where("firebase_uid = ?", "test-uid-me").Count(&count)
	assert.Equal(t, int64(1), count)
}

func newProfileRouter(t *testing.T, db *gorm.DB, uid, email string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: email}}
	repo := NewRepository(db)
	h := NewHandler(repo, Service{})
	r.PATCH("/v1/me", auth.Middleware(v), ResolveMiddleware(repo), h.UpdateProfile)
	return r
}

func patchProfile(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPatch, "/v1/me", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestUpdateProfileSetsDisplayName(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-name") })
	r := newProfileRouter(t, db, "test-uid-name", "name@test.dev")

	w := patchProfile(t, r, `{"display_name":"  Ada Lovelace  "}`)

	require.Equal(t, http.StatusOK, w.Code)
	// Asserts the TRIMMED value, so an implementation that skips trimming fails.
	assert.Contains(t, w.Body.String(), `"display_name":"Ada Lovelace"`)

	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-name").Scan(&got)
	assert.Equal(t, "Ada Lovelace", got)
}

func TestUpdateProfileRejectsEmptyAfterTrim(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-empty") })
	r := newProfileRouter(t, db, "test-uid-empty", "empty@test.dev")

	// Seed a real name first, so "unchanged" is a PRESENCE, not the initial
	// empty string — otherwise this passes against a handler that writes
	// nothing at all.
	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"display_name":"Grace"}`).Code)

	w := patchProfile(t, r, `{"display_name":"   "}`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-empty").Scan(&got)
	assert.Equal(t, "Grace", got)
}

func TestUpdateProfileRejectsOverLengthAndLeavesRowIntact(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-long") })
	r := newProfileRouter(t, db, "test-uid-long", "long@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"display_name":"Grace"}`).Code)

	long := strings.Repeat("a", 101)
	w := patchProfile(t, r, `{"display_name":"`+long+`"}`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-long").Scan(&got)
	assert.Equal(t, "Grace", got)
}

func TestUpdateProfileAcceptsExactlyMaxLength(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-max") })
	r := newProfileRouter(t, db, "test-uid-max", "max@test.dev")

	exact := strings.Repeat("a", 100)
	w := patchProfile(t, r, `{"display_name":"`+exact+`"}`)

	// Pins the boundary as inclusive: an off-by-one `>= 100` guard fails here.
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestUpdateProfileWritesOnlyTheCallersRow(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE firebase_uid IN (?, ?)", "test-uid-a", "test-uid-b")
	})
	// Two real users. The second must be untouched by the first's request.
	rb := newProfileRouter(t, db, "test-uid-b", "b@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, rb, `{"display_name":"Bob"}`).Code)

	ra := newProfileRouter(t, db, "test-uid-a", "a@test.dev")
	require.Equal(t, http.StatusOK, patchProfile(t, ra, `{"display_name":"Alice"}`).Code)

	var bName string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-b").Scan(&bName)
	assert.Equal(t, "Bob", bName)
}

func TestUpdateProfileAcceptsMultibyteUnder100Chars(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-cjk") })
	r := newProfileRouter(t, db, "test-uid-cjk", "cjk@test.dev")

	// 40 CJK characters: each is ~3 UTF-8 bytes, so ~120 bytes total,
	// but only 40 characters (runes). Should be accepted with character-based check,
	// rejected with byte-based check.
	cjkName := strings.Repeat("中", 40)
	body := `{"display_name":"` + cjkName + `"}`

	w := patchProfile(t, r, body)

	require.Equal(t, http.StatusOK, w.Code, "40-character CJK name should be accepted (character-based check)")
	assert.Contains(t, w.Body.String(), cjkName)

	var got string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-cjk").Scan(&got)
	assert.Equal(t, cjkName, got, "40-character CJK name should round-trip unchanged")
}

// newDeleteMeRouter mounts DELETE /v1/me with the same middleware chain
// router.go uses (auth.Middleware then ResolveMiddleware), so the id the
// handler reads comes from the real resolution path and not a hand-set
// context key. uid must be the seeded user's firebase_uid, otherwise
// ResolveMiddleware provisions a DIFFERENT row and the test would delete
// something it never seeded.
func newDeleteMeRouter(t *testing.T, db *gorm.DB, uid string, svc Service) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	repo := NewRepository(db)
	h := NewHandler(repo, svc)
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: uid + "@test.dev"}}
	r.DELETE("/v1/me", auth.Middleware(v), ResolveMiddleware(repo), h.DeleteMe)
	return r
}

func deleteMe(t *testing.T, r *gin.Engine) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodDelete, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	return w
}

// countUsers is the only honest way to assert a deletion happened: a 204
// proves the handler returned, not that any row was destroyed.
func countUsers(t *testing.T, db *gorm.DB, id uuid.UUID) int64 {
	t.Helper()
	var n int64
	require.NoError(t, db.Raw(`SELECT count(*) FROM users WHERE id = ?`, id).Scan(&n).Error)
	return n
}

func TestDeleteMeReturns204AndRemovesTheCaller(t *testing.T) {
	db := testDB(t)
	victim, survivor := seedUser(t, db), seedUser(t, db)
	r := newDeleteMeRouter(t, db, victim.FirebaseUID, newTestService(t, db))

	w := deleteMe(t, r)

	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Zero(t, countUsers(t, db, victim.ID), "the caller's row must be gone")
	// A cascade that took the whole table would also leave the caller gone.
	assert.Equal(t, int64(1), countUsers(t, db, survivor.ID), "only the caller may be deleted")
}

func TestDeleteMeReturns204EvenWhenFirebaseFails(t *testing.T) {
	db := testDB(t)
	victim := seedUser(t, db)
	r := newDeleteMeRouter(t, db, victim.FirebaseUID, newTestServiceWithFailingFirebase(t, db))

	w := deleteMe(t, r)

	// 204, not 500: the data IS gone, and a self-deleting user's path
	// self-heals (sign in, EnsureUser makes a fresh empty row, delete again).
	// Reporting 500 would tell them nothing happened when everything did.
	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Zero(t, countUsers(t, db, victim.ID), "the row must be gone despite the Firebase failure")
}

// The handler is mounted behind ResolveMiddleware in router.go, so an
// unresolved caller should be impossible — but DeleteMe destroys data, and a
// missing id must never fall through to a zero uuid.
func TestDeleteMeWithoutAResolvedUserIs401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request, _ = http.NewRequest(http.MethodDelete, "/v1/me", nil)

	Handler{}.DeleteMe(c)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestUpdateProfileMultibyteBoundary(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE firebase_uid IN (?, ?)", "test-uid-mb-100", "test-uid-mb-101")
	})

	// 100-rune multi-byte name should be accepted
	r100 := newProfileRouter(t, db, "test-uid-mb-100", "mb100@test.dev")
	name100 := strings.Repeat("é", 100) // é is 2 bytes, 1 rune
	w100 := patchProfile(t, r100, `{"display_name":"`+name100+`"}`)

	assert.Equal(t, http.StatusOK, w100.Code, "exactly 100 characters should be accepted")
	var got100 string
	db.Raw("SELECT display_name FROM users WHERE firebase_uid = ?", "test-uid-mb-100").Scan(&got100)
	assert.Equal(t, name100, got100)

	// 101-rune multi-byte name should be rejected
	r101 := newProfileRouter(t, db, "test-uid-mb-101", "mb101@test.dev")
	name101 := strings.Repeat("é", 101)
	w101 := patchProfile(t, r101, `{"display_name":"`+name101+`"}`)

	assert.Equal(t, http.StatusBadRequest, w101.Code, "101 characters should be rejected")
}

func TestUpdateProfileSetsTimezone(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-tz") })
	r := newProfileRouter(t, db, "test-uid-tz", "tz@test.dev")

	w := patchProfile(t, r, `{"timezone":"Asia/Kolkata"}`)

	require.Equal(t, http.StatusOK, w.Code)
	var got string
	db.Raw("SELECT timezone FROM users WHERE firebase_uid = ?", "test-uid-tz").Scan(&got)
	assert.Equal(t, "Asia/Kolkata", got, "the pre-#84 default Australia/Sydney must be replaceable")
}

// TestUpdateProfileTimezoneOnlyLeavesTheNameAlone is the reason the request
// body uses pointers. A client patching only the timezone must not be read as
// clearing the display name.
func TestUpdateProfileTimezoneOnlyLeavesTheNameAlone(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-tzname") })
	r := newProfileRouter(t, db, "test-uid-tzname", "tzname@test.dev")

	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"display_name":"Grace Hopper"}`).Code)
	require.Equal(t, http.StatusOK, patchProfile(t, r, `{"timezone":"Europe/London"}`).Code)

	var name, tz string
	db.Raw("SELECT display_name, timezone FROM users WHERE firebase_uid = ?", "test-uid-tzname").Row().Scan(&name, &tz)
	assert.Equal(t, "Grace Hopper", name, "a timezone-only patch must not clear the name")
	assert.Equal(t, "Europe/London", tz)
}

func TestUpdateProfileRejectsBadTimezones(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-badtz") })
	r := newProfileRouter(t, db, "test-uid-badtz", "badtz@test.dev")

	for _, tc := range []struct{ body, why string }{
		{`{"timezone":"Mars/Olympus_Mons"}`, "an unknown zone must not be stored"},
		{`{"timezone":"   "}`, "blank is not a zone"},
		// time.LoadLocation ACCEPTS both of these, which is exactly why they
		// are refused explicitly: "" resolves to UTC and "Local" to the
		// SERVER's zone, so either would store successfully and then silently
		// resolve every streak window and food locale against the wrong place.
		{`{"timezone":""}`, `"" is UTC to LoadLocation, never what the user meant`},
		{`{"timezone":"Local"}`, `"Local" is the server's zone, never the user's`},
		{`{}`, "a patch with no fields has nothing to do"},
	} {
		t.Run(tc.why, func(t *testing.T) {
			w := patchProfile(t, r, tc.body)
			require.Equal(t, http.StatusBadRequest, w.Code, tc.why)
			var tz string
			db.Raw("SELECT timezone FROM users WHERE firebase_uid = ?", "test-uid-badtz").Scan(&tz)
			assert.Equal(t, DefaultTimezone, tz, "a rejected patch must leave the row untouched")
		})
	}
}

// fakeAvatarURL is the test double used everywhere below that a composer is
// wired: it mirrors the real contract (assets.Store.URL / assetsStore(...).URL)
// of returning "" for an empty path, so a test asserting "" for "no picture"
// is actually exercising the handler's own behaviour, not a quirk of a naive
// stub -- the same shape as social's and share's test composers.
func fakeAvatarURL(path string) string {
	if path == "" {
		return ""
	}
	return "https://assets.test/" + path
}

// newMeRouter mounts GET /v1/me with an optional avatarURL composer, so
// tests can exercise both Handler.WithAvatarURL(...) wired and NOT wired
// (nil avatarURL is a real, currently-shipped code path -- assetsStore(nil)
// degrades to assets.Noop{} in router.go, and a Handler built without the
// builder call must behave the same way: avatar_url "").
func newMeRouter(t *testing.T, db *gorm.DB, uid, email string, avatarURL func(string) string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: email}}
	h := NewHandler(NewRepository(db), Service{})
	if avatarURL != nil {
		h = h.WithAvatarURL(avatarURL)
	}
	r.GET("/v1/me", auth.Middleware(v), h.Me)
	return r
}

func getMe(t *testing.T, r *gin.Engine) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer anything")
	r.ServeHTTP(w, req)
	return w
}

func TestMeReturnsEmptyAvatarURLWithNoPicture(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-avatar-none") })
	r := newMeRouter(t, db, "test-uid-avatar-none", "avatar-none@test.dev", fakeAvatarURL)

	w := getMe(t, r)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"avatar_url":""`)
}

func TestMeReturnsComposedAvatarURLWhenAvatarPathSet(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-avatar-set") })
	// First call provisions the row (UpsertByFirebaseUID), same as
	// TestMeCreatesUserOnFirstCall -- avatar_path cannot be seeded before the
	// row exists.
	r := newMeRouter(t, db, "test-uid-avatar-set", "avatar-set@test.dev", fakeAvatarURL)
	require.Equal(t, http.StatusOK, getMe(t, r).Code)

	require.NoError(t, db.Exec(
		"UPDATE users SET avatar_path = ? WHERE firebase_uid = ?",
		"avatars/test-uid-avatar-set/v1.jpg", "test-uid-avatar-set").Error)

	w := getMe(t, r)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"avatar_url":"https://assets.test/avatars/test-uid-avatar-set/v1.jpg"`)
}

// A Handler built WITHOUT .WithAvatarURL(...) is a real, currently-shipped
// state -- a nil avatarURL must degrade to "" rather than panic, the same
// "no composer wired = no picture" contract assets.Noop{} gives everywhere
// else avatars are wired.
func TestMeWithoutAvatarURLComposerStillRespondsEmpty(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-avatar-nocomposer") })
	r := newMeRouter(t, db, "test-uid-avatar-nocomposer", "avatar-nocomposer@test.dev", nil)
	require.Equal(t, http.StatusOK, getMe(t, r).Code)

	require.NoError(t, db.Exec(
		"UPDATE users SET avatar_path = ? WHERE firebase_uid = ?",
		"avatars/test-uid-avatar-nocomposer/v1.jpg", "test-uid-avatar-nocomposer").Error)

	w := getMe(t, r)

	require.Equal(t, http.StatusOK, w.Code)
	// Not "https://..." -- with no composer wired the picture must not
	// silently disappear into a broken link either; "" is the only safe
	// value and is what the client falls back to initials on.
	assert.Contains(t, w.Body.String(), `"avatar_url":""`)
}

// newProfileRouterWithAvatar is newProfileRouter plus a wired avatarURL
// composer, for asserting PATCH /v1/me also serialises avatar_url (kora#449
// task 10 review finding: WithAvatarURL shipped with no PATCH coverage).
func newProfileRouterWithAvatar(t *testing.T, db *gorm.DB, uid, email string, avatarURL func(string) string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: email}}
	repo := NewRepository(db)
	h := NewHandler(repo, Service{}).WithAvatarURL(avatarURL)
	r.PATCH("/v1/me", auth.Middleware(v), ResolveMiddleware(repo), h.UpdateProfile)
	return r
}

// TestUpdateProfileReturnsAvatarURLAndDoesNotClobberPicture pins two things
// at once: PATCH /v1/me carries avatar_url (not just GET), and patching an
// UNRELATED field (timezone here) must not touch the stored avatar_path --
// UpdateProfile only ever writes DisplayName/Timezone, but this is the test
// that would catch a future change accidentally zeroing AvatarPath on write.
func TestUpdateProfileReturnsAvatarURLAndDoesNotClobberPicture(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "test-uid-avatar-patch") })
	meRouter := newMeRouter(t, db, "test-uid-avatar-patch", "avatar-patch@test.dev", fakeAvatarURL)
	require.Equal(t, http.StatusOK, getMe(t, meRouter).Code) // provisions the row

	require.NoError(t, db.Exec(
		"UPDATE users SET avatar_path = ? WHERE firebase_uid = ?",
		"avatars/test-uid-avatar-patch/v1.jpg", "test-uid-avatar-patch").Error)

	r := newProfileRouterWithAvatar(t, db, "test-uid-avatar-patch", "avatar-patch@test.dev", fakeAvatarURL)
	w := patchProfile(t, r, `{"timezone":"Asia/Kolkata"}`)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"avatar_url":"https://assets.test/avatars/test-uid-avatar-patch/v1.jpg"`,
		"an unrelated field patch must not clear the picture")

	var path string
	db.Raw("SELECT avatar_path FROM users WHERE firebase_uid = ?", "test-uid-avatar-patch").Scan(&path)
	assert.Equal(t, "avatars/test-uid-avatar-patch/v1.jpg", path, "the stored path itself must survive an unrelated patch")
}
