package challenges

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/groups"
)

func mountFor(caller uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", caller); c.Next() })
	repo := NewRepository(db)
	svc := NewService(repo, groups.NewRepository(db), foodlog.NewRepository(db))
	h := NewHandler(svc)
	r.POST("/v1/groups/:id/challenges", h.Create)
	r.GET("/v1/groups/:id/challenges", h.List)
	r.POST("/v1/challenges/:cid/join", h.Join)
	r.DELETE("/v1/challenges/:cid/join", h.Leave)
	r.GET("/v1/challenges/:cid", h.Detail)
	r.DELETE("/v1/challenges/:cid", h.Delete)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestCreateChallengeMemberVsNonMember(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	// owner (a member) can create
	rOwner := mountFor(owner, db)
	w := doJSON(rOwner, http.MethodPost, "/v1/groups/"+gid.String()+"/challenges", `{"title":"Streak","metric":"logged","duration":"1w"}`)
	require.Equal(t, http.StatusCreated, w.Code)

	// a stranger cannot create
	rStranger := mountFor(stranger, db)
	w2 := doJSON(rStranger, http.MethodPost, "/v1/groups/"+gid.String()+"/challenges", `{"title":"X","metric":"logged","duration":"1w"}`)
	require.Equal(t, http.StatusForbidden, w2.Code)
}

func TestDetailAndDeleteGating(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	memberU := seedUser(t, db, "Member", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	require.NoError(t, db.Exec("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')", gid, memberU).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	repo := NewRepository(db)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Streak", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	// stranger cannot view detail
	rStranger := mountFor(stranger, db)
	require.Equal(t, http.StatusForbidden, doJSON(rStranger, http.MethodGet, "/v1/challenges/"+ch.ID.String(), "").Code)

	// a plain member cannot delete someone else's challenge
	rMember := mountFor(memberU, db)
	require.Equal(t, http.StatusForbidden, doJSON(rMember, http.MethodDelete, "/v1/challenges/"+ch.ID.String(), "").Code)

	// the creator (owner) can view and delete
	rOwner := mountFor(owner, db)
	require.Equal(t, http.StatusOK, doJSON(rOwner, http.MethodGet, "/v1/challenges/"+ch.ID.String(), "").Code)
	require.Equal(t, http.StatusOK, doJSON(rOwner, http.MethodDelete, "/v1/challenges/"+ch.ID.String(), "").Code)
}

func TestListMemberVsNonMember(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	repo := NewRepository(db)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	_, err := repo.Create(context.Background(), gid, owner, "Streak", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	// a non-member cannot list
	rStranger := mountFor(stranger, db)
	require.Equal(t, http.StatusForbidden, doJSON(rStranger, http.MethodGet, "/v1/groups/"+gid.String()+"/challenges", "").Code)

	// a member can list
	rOwner := mountFor(owner, db)
	require.Equal(t, http.StatusOK, doJSON(rOwner, http.MethodGet, "/v1/groups/"+gid.String()+"/challenges", "").Code)
}

func TestJoinAndLeaveGating(t *testing.T) {
	db := testDB(t)
	owner := seedUser(t, db, "Owner", 2000)
	memberU := seedUser(t, db, "Member", 2000)
	stranger := seedUser(t, db, "Stranger", 2000)
	gid := seedGroup(t, db, owner)
	require.NoError(t, db.Exec("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')", gid, memberU).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM challenges WHERE group_id = ?", gid) })

	repo := NewRepository(db)
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ch, err := repo.Create(context.Background(), gid, owner, "Streak", MetricLogged, start, start.AddDate(0, 0, 7))
	require.NoError(t, err)

	// a member can join
	rMember := mountFor(memberU, db)
	require.Equal(t, http.StatusOK, doJSON(rMember, http.MethodPost, "/v1/challenges/"+ch.ID.String()+"/join", "").Code)

	// a stranger cannot join
	rStranger := mountFor(stranger, db)
	require.Equal(t, http.StatusForbidden, doJSON(rStranger, http.MethodPost, "/v1/challenges/"+ch.ID.String()+"/join", "").Code)

	// joining an unknown challenge id 404s
	require.Equal(t, http.StatusNotFound, doJSON(rMember, http.MethodPost, "/v1/challenges/"+uuid.New().String()+"/join", "").Code)

	// the member can leave
	require.Equal(t, http.StatusOK, doJSON(rMember, http.MethodDelete, "/v1/challenges/"+ch.ID.String()+"/join", "").Code)
}
