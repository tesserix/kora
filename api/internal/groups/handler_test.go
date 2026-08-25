package groups

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

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/social"
	"github.com/tesserix/kora/api/internal/user"
)

func foodLogSourceFor(db *gorm.DB) foodlog.Repository { return foodlog.NewRepository(db) }

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	repo := NewRepository(db)
	svc := NewService(repo, social.NewRepository(db), NewCode)
	accessSvc := access.NewService(access.NewRepository(db))
	h := NewHandler(svc, repo, compare.NewService(social.NewRepository(db), user.NewRepository(db), foodLogSourceFor(db)), accessSvc)
	r.POST("/v1/groups", h.Create)
	r.GET("/v1/groups", h.List)
	r.POST("/v1/groups/join", h.Join)
	r.GET("/v1/groups/:id", h.Detail)
	r.GET("/v1/groups/:id/code", h.Code)
	r.GET("/v1/groups/:id/progress", h.Progress)
	r.PATCH("/v1/groups/:id", h.Rename)
	r.DELETE("/v1/groups/:id", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func extractFirstGroupID(t *testing.T, db *gorm.DB, owner uuid.UUID) uuid.UUID {
	var id uuid.UUID
	row := db.Raw("SELECT g.id FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? LIMIT 1", owner).Row()
	require.NoError(t, row.Scan(&id))
	t.Cleanup(func() { db.Exec("DELETE FROM groups WHERE id = ?", id) })
	return id
}

func TestCreateThenNonMemberDetailForbidden(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	stranger := seedUser(t, db, "Stranger")

	rOwner := mountFor(owner, db)
	w := doJSON(rOwner, http.MethodPost, "/v1/groups", `{"name":"Squad"}`)
	require.Equal(t, http.StatusCreated, w.Code)

	// list to grab the id
	wl := doJSON(rOwner, http.MethodGet, "/v1/groups", "")
	require.Equal(t, http.StatusOK, wl.Code)
	// crude id extraction
	id := extractFirstGroupID(t, db, owner)

	rStranger := mountFor(stranger, db)
	wd := doJSON(rStranger, http.MethodGet, "/v1/groups/"+id.String(), "")
	require.Equal(t, http.StatusForbidden, wd.Code)
}

// seedShareGrant inserts a real share_circles/share_circle_members/share_grants
// row so ownerID grants viewerID the given category. This exercises the real
// access.Repository query, not a fake -- the whole point of this task is that
// the endpoint's gate is wired to that real resolution.
func seedShareGrant(t *testing.T, db *gorm.DB, ownerID, viewerID uuid.UUID, category string) {
	t.Helper()
	circleID := uuid.New()
	require.NoError(t, db.Exec("INSERT INTO share_circles (id, owner_id, name) VALUES (?, ?, ?)",
		circleID, ownerID, "circle-"+circleID.String()).Error)
	require.NoError(t, db.Exec("INSERT INTO share_circle_members (circle_id, member_user_id) VALUES (?, ?)",
		circleID, viewerID).Error)
	require.NoError(t, db.Exec("INSERT INTO share_grants (circle_id, category) VALUES (?, ?)",
		circleID, category).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM share_circles WHERE id = ?", circleID) })
}

// TestProgressGatesOnResolvedGrant is the security-critical assertion for
// kora#326: a group member's metrics only appear when they have granted the
// caller a real "progress" share_grant, resolved through the actual
// access.Repository -- not a global flag.
func TestProgressGatesOnResolvedGrant(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	sharer := seedUser(t, db, "Sharer")
	private := seedUser(t, db, "Private")

	rOwner := mountFor(owner, db)
	require.Equal(t, http.StatusCreated, doJSON(rOwner, http.MethodPost, "/v1/groups", `{"name":"Squad"}`).Code)
	id := extractFirstGroupID(t, db, owner)
	wc := httptest.NewRecorder()
	rOwner.ServeHTTP(wc, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/code", nil))
	require.Equal(t, http.StatusOK, wc.Code)
	var codeBody struct {
		Data struct {
			Code string `json:"code"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(wc.Body.Bytes(), &codeBody))

	rSharer := mountFor(sharer, db)
	require.Equal(t, http.StatusOK, doJSON(rSharer, http.MethodPost, "/v1/groups/join",
		`{"code":"`+codeBody.Data.Code+`"}`).Code)
	rPrivate := mountFor(private, db)
	require.Equal(t, http.StatusOK, doJSON(rPrivate, http.MethodPost, "/v1/groups/join",
		`{"code":"`+codeBody.Data.Code+`"}`).Code)

	// Only sharer grants the owner a "progress" share -- private never does.
	seedShareGrant(t, db, sharer, owner, "progress")

	wp := httptest.NewRecorder()
	rOwner.ServeHTTP(wp, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/progress", nil))
	require.Equal(t, http.StatusOK, wp.Code)

	var body struct {
		Data struct {
			Members []struct {
				DisplayName string `json:"display_name"`
				Sharing     bool   `json:"sharing"`
				StreakDays  *int   `json:"streak_days"`
			} `json:"members"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(wp.Body.Bytes(), &body))
	byName := map[string]bool{}
	streaks := map[string]*int{}
	for _, m := range body.Data.Members {
		byName[m.DisplayName] = m.Sharing
		streaks[m.DisplayName] = m.StreakDays
	}
	require.True(t, byName["Sharer"], "sharer granted progress, so must show as sharing")
	require.NotNil(t, streaks["Sharer"], "sharer's metrics must be computed")
	require.False(t, byName["Private"], "private never granted progress, so must not show as sharing")
	require.Nil(t, streaks["Private"], "private's metrics must NEVER be computed")
}

func TestCodeAndProgressForbiddenForNonMember(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner")
	stranger := seedUser(t, db, "Stranger")
	rOwner := mountFor(owner, db)
	require.Equal(t, http.StatusCreated, doJSON(rOwner, http.MethodPost, "/v1/groups", `{"name":"Squad"}`).Code)
	id := extractFirstGroupID(t, db, owner)

	rStranger := mountFor(stranger, db)
	wc := httptest.NewRecorder()
	rStranger.ServeHTTP(wc, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/code", nil))
	require.Equal(t, http.StatusForbidden, wc.Code)
	wp := httptest.NewRecorder()
	rStranger.ServeHTTP(wp, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/progress", nil))
	require.Equal(t, http.StatusForbidden, wp.Code)
}

// progressSharingFor extracts (sharing, streak_days present) for displayName
// from a /v1/groups/:id/progress response.
func progressSharingFor(t *testing.T, w *httptest.ResponseRecorder, displayName string) (sharing bool, hasStreak bool) {
	t.Helper()
	var body struct {
		Data struct {
			Members []struct {
				DisplayName string `json:"display_name"`
				Sharing     bool   `json:"sharing"`
				StreakDays  *int   `json:"streak_days"`
			} `json:"members"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	for _, m := range body.Data.Members {
		if m.DisplayName == displayName {
			return m.Sharing, m.StreakDays != nil
		}
	}
	t.Fatalf("member %q not found in progress response", displayName)
	return false, false
}

// TestUnfriendingRevokesCircleAccessInGroupProgress is the F2 regression from
// the kora#326 whole-branch review: Unfriend must revoke share_circle_members
// too, not just the friendships row. A owner and B viewer are friends, share
// a group, and A has granted B a "progress" circle. Once A and B unfriend,
// B's membership in A's circle must be gone -- so B must stop seeing A's
// figures via GET /v1/groups/:id/progress, the exact leak path a join-free
// GrantedOwners query would otherwise miss.
func TestUnfriendingRevokesCircleAccessInGroupProgress(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ana")
	b := seedUser(t, db, "Bo")

	socialSvc := social.NewService(social.NewRepository(db), user.NewRepository(db), func(string) string { return "" })
	_, err := socialSvc.SendRequest(t.Context(), a, "gr-"+b.String()+"@test.dev", "")
	require.NoError(t, err)
	// Accept needs the request id; fetch it via ListRequests on B's side.
	incomingForB, _, err := socialSvc.ListRequests(t.Context(), b)
	require.NoError(t, err)
	require.Len(t, incomingForB, 1)
	require.NoError(t, socialSvc.Accept(t.Context(), b, incomingForB[0].ID))

	rA := mountFor(a, db)
	require.Equal(t, http.StatusCreated, doJSON(rA, http.MethodPost, "/v1/groups", `{"name":"Squad"}`).Code)
	id := extractFirstGroupID(t, db, a)
	wc := httptest.NewRecorder()
	rA.ServeHTTP(wc, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/code", nil))
	require.Equal(t, http.StatusOK, wc.Code)
	var codeBody struct {
		Data struct {
			Code string `json:"code"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(wc.Body.Bytes(), &codeBody))

	rB := mountFor(b, db)
	require.Equal(t, http.StatusOK, doJSON(rB, http.MethodPost, "/v1/groups/join",
		`{"code":"`+codeBody.Data.Code+`"}`).Code)

	// A grants B a "progress" share.
	seedShareGrant(t, db, a, b, "progress")

	// Before unfriending: B sees A's figures.
	wBefore := httptest.NewRecorder()
	rB.ServeHTTP(wBefore, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/progress", nil))
	require.Equal(t, http.StatusOK, wBefore.Code)
	sharing, hasStreak := progressSharingFor(t, wBefore, "Ana")
	require.True(t, sharing, "B must see A as sharing before unfriending")
	require.True(t, hasStreak, "B must see A's computed streak before unfriending")

	require.NoError(t, socialSvc.Unfriend(t.Context(), a, b))

	// After unfriending: B must no longer see A's figures.
	wAfter := httptest.NewRecorder()
	rB.ServeHTTP(wAfter, httptest.NewRequest(http.MethodGet, "/v1/groups/"+id.String()+"/progress", nil))
	require.Equal(t, http.StatusOK, wAfter.Code)
	sharing, hasStreak = progressSharingFor(t, wAfter, "Ana")
	require.False(t, sharing, "unfriending must revoke B's circle membership, closing the group-progress leak")
	require.False(t, hasStreak, "A's metrics must never be computed for B after unfriending")
}
