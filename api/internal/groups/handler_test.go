package groups

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

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
	h := NewHandler(svc, repo, compare.NewService(social.NewRepository(db), user.NewRepository(db), foodLogSourceFor(db)))
	r.POST("/v1/groups", h.Create)
	r.GET("/v1/groups", h.List)
	r.POST("/v1/groups/join", h.Join)
	r.GET("/v1/groups/:id", h.Detail)
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
