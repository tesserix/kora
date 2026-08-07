package user

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
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
	h := NewHandler(NewRepository(db))
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
	h := NewHandler(repo)
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
