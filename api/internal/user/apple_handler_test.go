package user

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/auth"
)

type fakeExchanger struct {
	code    string
	token   string
	err     error
	calls   int
}

func (f *fakeExchanger) ExchangeAuthorizationCode(_ context.Context, code string) (string, error) {
	f.calls++
	f.code = code
	return f.token, f.err
}

func newAppleRouter(t *testing.T, db *gorm.DB, ex AppleExchanger, uid string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	repo := NewRepository(db)
	h := NewAppleHandler(repo, ex)
	v := staticVerifier{claims: auth.Claims{UID: uid, Email: uid + "@test.dev"}}
	r.POST("/v1/me/apple-authorization", auth.Middleware(v), ResolveMiddleware(repo), h.Store)
	return r
}

func postApple(t *testing.T, r *gin.Engine, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, "/v1/me/apple-authorization", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer anything")
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func storedToken(t *testing.T, db *gorm.DB, uid string) string {
	t.Helper()
	var got *string
	db.Raw("SELECT apple_refresh_token FROM users WHERE firebase_uid = ?", uid).Scan(&got)
	if got == nil {
		return ""
	}
	return *got
}

func TestAppleStorePersistsTheExchangedRefreshToken(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "apple-uid-1") })
	ex := &fakeExchanger{token: "rt-stored"}
	r := newAppleRouter(t, db, ex, "apple-uid-1")

	w := postApple(t, r, `{"authorization_code":"code-123"}`)

	require.Equal(t, http.StatusNoContent, w.Code)
	assert.Equal(t, "code-123", ex.code)
	assert.Equal(t, "rt-stored", storedToken(t, db, "apple-uid-1"))
}

func TestAppleStoreOverwritesAnEarlierToken(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "apple-uid-2") })
	ex := &fakeExchanger{token: "rt-first"}
	r := newAppleRouter(t, db, ex, "apple-uid-2")
	require.Equal(t, http.StatusNoContent, postApple(t, r, `{"authorization_code":"c1"}`).Code)

	ex.token = "rt-second"
	require.Equal(t, http.StatusNoContent, postApple(t, r, `{"authorization_code":"c2"}`).Code)

	// Apple issues a fresh code per authorization; the newest is the one still
	// valid at deletion time. Seeded with a real first value so "unchanged"
	// would be a visible failure rather than the initial NULL.
	assert.Equal(t, "rt-second", storedToken(t, db, "apple-uid-2"))
}

func TestAppleStoreRejectsAnEmptyCodeWithoutCallingApple(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "apple-uid-3") })
	ex := &fakeExchanger{token: "rt-should-not-store"}
	r := newAppleRouter(t, db, ex, "apple-uid-3")
	// Seed a real token first, so an implementation that clobbers on a bad
	// request fails visibly instead of matching the initial NULL.
	require.Equal(t, http.StatusNoContent, postApple(t, r, `{"authorization_code":"good"}`).Code)

	w := postApple(t, r, `{"authorization_code":"   "}`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, 1, ex.calls, "must not spend an Apple call on an empty code")
	assert.Equal(t, "rt-should-not-store", storedToken(t, db, "apple-uid-3"))
}

func TestAppleStoreReportsAnExchangeFailureAndStoresNothing(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "apple-uid-4") })
	ex := &fakeExchanger{token: "rt-seeded"}
	r := newAppleRouter(t, db, ex, "apple-uid-4")
	// Seed a real token so "nothing was stored" is a PRESENCE that survives,
	// not the row's initial zero value — otherwise a handler that fell through
	// and wrote "" would pass this test.
	require.Equal(t, http.StatusNoContent, postApple(t, r, `{"authorization_code":"good"}`).Code)

	// appleid.Client returns "" alongside an error on every failure path, so
	// the fake mirrors that: without this, a handler that forgot the `return`
	// after the error branch would re-store the SAME seeded value, and this
	// test would pass against that bug.
	ex.token = ""
	ex.err = errors.New("appleid: status 400: invalid_client")
	w := postApple(t, r, `{"authorization_code":"code"}`)

	assert.Equal(t, http.StatusBadGateway, w.Code)
	assert.Equal(t, "rt-seeded", storedToken(t, db, "apple-uid-4"))
	// Apple's diagnostic must not reach the client.
	assert.NotContains(t, w.Body.String(), "invalid_client")
}

func TestAppleStoreRejectsAMalformedBody(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE firebase_uid = ?", "apple-uid-5") })
	ex := &fakeExchanger{token: "rt"}
	r := newAppleRouter(t, db, ex, "apple-uid-5")

	w := postApple(t, r, `not json`)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Equal(t, 0, ex.calls)
}
