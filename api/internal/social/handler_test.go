package social

import (
	"context"
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

func mountFor(callerID uuid.UUID, db *gorm.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) { c.Set("user_id", callerID); c.Next() })
	h := NewHandler(NewService(NewRepository(db), user.NewRepository(db)))
	r.GET("/v1/friends", h.ListFriends)
	r.GET("/v1/friends/requests", h.ListRequests)
	r.POST("/v1/friends/requests", h.SendRequest)
	r.POST("/v1/friends/requests/:id/accept", h.Accept)
	r.POST("/v1/friends/requests/:id/decline", h.Decline)
	r.DELETE("/v1/friends/:userId", h.Unfriend)
	r.GET("/v1/friends/code", h.Code)
	return r
}

func doPOST(r *gin.Engine, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestSendRequestStatusCodes(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	other := seedUser(t, db, "Other")
	r := mountFor(me, db)
	otherEmail := "so-" + other.String() + "@test.dev"

	// both fields -> 400
	require.Equal(t, http.StatusBadRequest, doPOST(r, "/v1/friends/requests", `{"email":"x@y.z","code":"C"}`).Code)
	// unknown -> 404
	require.Equal(t, http.StatusNotFound, doPOST(r, "/v1/friends/requests", `{"email":"nobody@nowhere.dev"}`).Code)
	// self -> 409
	selfEmail := "so-" + me.String() + "@test.dev"
	require.Equal(t, http.StatusConflict, doPOST(r, "/v1/friends/requests", `{"email":"`+selfEmail+`"}`).Code)
	// valid -> 201
	require.Equal(t, http.StatusCreated, doPOST(r, "/v1/friends/requests", `{"email":"`+otherEmail+`"}`).Code)
}

func TestAcceptForbiddenForNonAddressee(t *testing.T) {
	db := testDB(t)
	a := seedUser(t, db, "Ada")
	b := seedUser(t, db, "Ben")
	c := seedUser(t, db, "Cy")
	svc := NewService(NewRepository(db), user.NewRepository(db))
	f, err := svc.SendRequest(context.Background(), a, "so-"+b.String()+"@test.dev", "")
	require.NoError(t, err)

	// c tries to accept a->b request -> 403
	rc := mountFor(c, db)
	require.Equal(t, http.StatusForbidden, doPOST(rc, "/v1/friends/requests/"+f.ID.String()+"/accept", "").Code)
	// b accepts -> 200
	rb := mountFor(b, db)
	require.Equal(t, http.StatusOK, doPOST(rb, "/v1/friends/requests/"+f.ID.String()+"/accept", "").Code)
}

func TestListFriendsAndCodeShape(t *testing.T) {
	db := testDB(t)
	me := seedUser(t, db, "Me")
	r := mountFor(me, db)

	req := httptest.NewRequest(http.MethodGet, "/v1/friends/code", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Data struct {
			Code string `json:"code"`
			Link string `json:"link"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.NotEmpty(t, body.Data.Code)
	require.Equal(t, "mobile://friend/"+body.Data.Code, body.Data.Link)
}
