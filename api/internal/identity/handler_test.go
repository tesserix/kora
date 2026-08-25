package identity

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/user"
)

func engine(t *testing.T, db *gorm.DB, as uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := NewHandler(newSvc(db))
	r := gin.New()
	r.Use(func(c *gin.Context) {
		if as != uuid.Nil {
			user.SetIDForTest(c, as)
		}
		c.Next()
	})
	r.GET("/v1/users/lookup", h.Lookup)
	r.GET("/v1/me/handle", h.GetHandle)
	r.PUT("/v1/me/handle", h.SetHandle)
	r.DELETE("/v1/me/handle", h.ClearHandle)
	return r
}

func do(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	return rec
}

func TestHandler_SetThenLookup(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	t.Cleanup(func() { retireCleanup(t, db, "adalove") })
	r := engine(t, db, id)

	rec := do(r, http.MethodPut, "/v1/me/handle", `{"handle":"adalove"}`)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	rec = do(r, http.MethodGet, "/v1/users/lookup?handle=ADALOVE", "")
	require.Equal(t, 200, rec.Code)

	var env struct{ Data LookupView }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Equal(t, id, env.Data.ID)
	require.Equal(t, "adalove", env.Data.Handle)
}

func TestHandler_LookupMissIs404(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, seedUser(t, db))
	require.Equal(t, 404, do(r, http.MethodGet, "/v1/users/lookup?handle=nobodyhere", "").Code)
}

func TestHandler_LookupWithNoHandleParamIs400(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, seedUser(t, db))
	require.Equal(t, 400, do(r, http.MethodGet, "/v1/users/lookup", "").Code)
}

// The four write failures answer differently. Collapsing any two turns a
// fixable mistake into a dead end for the person typing.
func TestHandler_WriteErrorsAreDistinguishable(t *testing.T) {
	db := testDB(t)
	a, b := seedUser(t, db), seedUser(t, db)
	t.Cleanup(func() { retireCleanup(t, db, "mine", "gone") })

	ra, rb := engine(t, db, a), engine(t, db, b)
	require.Equal(t, 200, do(ra, http.MethodPut, "/v1/me/handle", `{"handle":"mine"}`).Code)

	cases := []struct {
		name, body, code string
		status           int
	}{
		{name: "invalid shape", body: `{"handle":"no"}`, status: 400, code: "invalid_handle"},
		{name: "reserved", body: `{"handle":"support"}`, status: 409, code: "handle_reserved"},
		{name: "taken", body: `{"handle":"m1ne"}`, status: 409, code: "handle_taken"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			rec := do(rb, http.MethodPut, "/v1/me/handle", tt.body)
			require.Equal(t, tt.status, rec.Code, rec.Body.String())
			var e struct{ Error string }
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
			require.Equal(t, tt.code, e.Error)
		})
	}

	// Retired needs its own history: claim, move away, then try to take it back.
	require.Equal(t, 200, do(rb, http.MethodPut, "/v1/me/handle", `{"handle":"gone"}`).Code)
	require.Equal(t, 200, do(rb, http.MethodPut, "/v1/me/handle", `{"handle":"elsewhere"}`).Code)
	rec := do(ra, http.MethodPut, "/v1/me/handle", `{"handle":"gone"}`)
	require.Equal(t, 409, rec.Code)
	var e struct{ Error string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
	require.Equal(t, "handle_retired", e.Error)
	retireCleanup(t, db, "elsewhere")
}

func TestHandler_ClearThenGetIsEmpty(t *testing.T) {
	db := testDB(t)
	id := seedUser(t, db)
	t.Cleanup(func() { retireCleanup(t, db, "temporary") })
	r := engine(t, db, id)

	require.Equal(t, 200, do(r, http.MethodPut, "/v1/me/handle", `{"handle":"temporary"}`).Code)
	require.Equal(t, 204, do(r, http.MethodDelete, "/v1/me/handle", "").Code)

	rec := do(r, http.MethodGet, "/v1/me/handle", "")
	require.Equal(t, 200, rec.Code)
	var env struct{ Data struct{ Handle string } }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
	require.Empty(t, env.Data.Handle)
}

func TestHandler_UnauthenticatedIs401(t *testing.T) {
	db := testDB(t)
	r := engine(t, db, uuid.Nil)
	require.Equal(t, 401, do(r, http.MethodGet, "/v1/users/lookup?handle=ada", "").Code)
	require.Equal(t, 401, do(r, http.MethodPut, "/v1/me/handle", `{"handle":"ada"}`).Code)
}

// A lookup response must never carry an email, even when the target has one.
func TestHandler_LookupResponseHasNoEmail(t *testing.T) {
	db := testDB(t)
	target := seedUser(t, db)
	t.Cleanup(func() { retireCleanup(t, db, "seen") })
	require.Equal(t, 200,
		do(engine(t, db, target), http.MethodPut, "/v1/me/handle", `{"handle":"seen"}`).Code)

	var email string
	require.NoError(t, db.Raw(`SELECT email FROM users WHERE id = ?`, target).Scan(&email).Error)

	rec := do(engine(t, db, seedUser(t, db)), http.MethodGet, "/v1/users/lookup?handle=seen", "")
	require.Equal(t, 200, rec.Code)
	require.NotContains(t, rec.Body.String(), email)
}
