package share

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func testRouter(t *testing.T, db *gorm.DB, userID uuid.UUID) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandler(NewService(NewRepository(db), stubFriends{areFriends: true}))
	g := r.Group("/v1", func(c *gin.Context) { c.Set("user_id", userID) })
	g.GET("/share/circles", h.List)
	g.POST("/share/circles", h.Create)
	g.DELETE("/share/circles/:id", h.Delete)
	g.POST("/share/circles/:id/members", h.AddMember)
	g.DELETE("/share/circles/:id/members/:userId", h.RemoveMember)
	g.PUT("/share/circles/:id/categories", h.SetCategories)
	g.POST("/share/circles/:id/leave", h.Leave)
	g.GET("/share/memberships", h.Memberships)
	return r
}

func TestCreateCircleReturnsIt(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	r := testRouter(t, db, owner)

	body, _ := json.Marshal(map[string]string{"name": "Household"})
	req := httptest.NewRequest(http.MethodPost, "/v1/share/circles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusCreated, w.Code)
	require.Contains(t, w.Body.String(), "Household")
}

func TestCreateCircleRejectsABlankName(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	r := testRouter(t, db, owner)

	body, _ := json.Marshal(map[string]string{"name": ""})
	req := httptest.NewRequest(http.MethodPost, "/v1/share/circles", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
}

// Modifying someone else's circle must not report 403 -- that confirms the
// circle exists. Same rule as ErrNotShared: not-yours and not-there are
// indistinguishable.
func TestModifyingAnotherOwnersCircleIs404(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "owner")
	attacker := seedUser(t, db, "attacker")
	victim, err := NewRepository(db).Create(t.Context(), owner, "Household")
	require.NoError(t, err)

	r := testRouter(t, db, attacker)
	body, _ := json.Marshal(map[string][]string{"categories": {"body"}})
	req := httptest.NewRequest(http.MethodPut, "/v1/share/circles/"+victim.ID.String()+"/categories",
		bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
}

// Leave MUST act only on the authenticated caller. It has no owner-gate of
// its own -- that's the whole point of Leave -- so if the handler ever took
// the member ID from request input instead of callerID(c), this endpoint
// would let anyone remove anyone else from any circle. An outsider (not a
// member) attempts the attack via every channel a regression could plausibly
// read from -- a JSON body and a query parameter, each carrying the real
// member's UUID as the payload -- and the real member must survive both.
// An empty-body request would NOT catch a handler that trusts request input:
// it would prove only that an omitted payload doesn't accidentally evict
// anyone, not that a malicious payload is ignored.
func TestLeaveOnlyRemovesTheAuthenticatedCaller(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)

	assertMemberSurvives := func(t *testing.T, owner, member uuid.UUID) {
		t.Helper()
		views, err := repo.ListForOwner(t.Context(), owner)
		require.NoError(t, err)
		require.Len(t, views, 1)
		require.Len(t, views[0].Members, 1)
		require.Equal(t, member, views[0].Members[0].ID)
	}

	t.Run("JSON body carrying the member's UUID is ignored", func(t *testing.T) {
		owner := seedUser(t, db, "owner")
		member := seedUser(t, db, "member")
		outsider := seedUser(t, db, "outsider")
		circle, err := repo.Create(t.Context(), owner, "Household")
		require.NoError(t, err)
		require.NoError(t, repo.AddMember(t.Context(), circle.ID, member))

		r := testRouter(t, db, outsider)
		body, _ := json.Marshal(map[string]string{"user_id": member.String()})
		req := httptest.NewRequest(http.MethodPost, "/v1/share/circles/"+circle.ID.String()+"/leave",
			bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)

		assertMemberSurvives(t, owner, member)
	})

	t.Run("query parameter carrying the member's UUID is ignored", func(t *testing.T) {
		owner := seedUser(t, db, "owner")
		member := seedUser(t, db, "member")
		outsider := seedUser(t, db, "outsider")
		circle, err := repo.Create(t.Context(), owner, "Household")
		require.NoError(t, err)
		require.NoError(t, repo.AddMember(t.Context(), circle.ID, member))

		r := testRouter(t, db, outsider)
		req := httptest.NewRequest(http.MethodPost,
			"/v1/share/circles/"+circle.ID.String()+"/leave?user_id="+member.String(), nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)

		assertMemberSurvives(t, owner, member)
	})
}

// kora#440, at HTTP level: the member-side list, and the leave it exists to
// make reachable.
func TestMembershipsEndpointListsWhatIsSharedWithYouAndLeaveRemovesIt(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Gym crew")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	r := testRouter(t, db, member)

	get := func() string {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/share/memberships", nil))
		require.Equal(t, http.StatusOK, w.Code)
		return w.Body.String()
	}

	body := get()
	require.Contains(t, body, c.ID.String())
	require.Contains(t, body, owner.String())
	// The owner's private label never crosses the wire to a member.
	require.NotContains(t, body, "Gym crew")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/share/circles/"+c.ID.String()+"/leave", nil))
	require.Equal(t, http.StatusOK, w.Code)

	require.NotContains(t, get(), c.ID.String(), "leaving must remove the membership")
}

// The member id comes from the authenticated caller alone. Leave is
// deliberately NOT owner-gated -- that is its purpose -- so the handler is the
// only guard, and it must never take a member id from request input.
func TestMembershipsShowsOnlyTheCallersOwnMemberships(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	member := seedUser(t, db, "Member")
	stranger := seedUser(t, db, "Stranger")
	repo := NewRepository(db)

	c, err := repo.Create(context.Background(), owner, "Household")
	require.NoError(t, err)
	require.NoError(t, repo.AddMember(context.Background(), c.ID, member))

	w := httptest.NewRecorder()
	testRouter(t, db, stranger).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/share/memberships", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), c.ID.String())
}
