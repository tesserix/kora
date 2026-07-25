package groups

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/compare"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

type Handler struct {
	svc     Service
	repo    Repository
	compare compare.Service
}

func NewHandler(svc Service, repo Repository, compareSvc compare.Service) Handler {
	return Handler{svc: svc, repo: repo, compare: compareSvc}
}

func (h Handler) uid(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

func mapErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrBadInput):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid input")
	case errors.Is(err, ErrNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "group not found")
	case errors.Is(err, ErrForbidden):
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
	case errors.Is(err, ErrOwnerCannotLeave):
		httpx.Error(c, http.StatusConflict, "conflict", "owner cannot leave; delete the group instead")
	case errors.Is(err, ErrNotFriends):
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "you can only invite a friend")
	default:
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "something went wrong")
	}
}

func (h Handler) parseID(c *gin.Context, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param(param))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

type nameBody struct {
	Name string `json:"name"`
}
type codeBody struct {
	Code string `json:"code"`
}
type inviteBody struct {
	UserID string `json:"user_id"`
}

func (h Handler) Create(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req nameBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	g, err := h.svc.Create(c.Request.Context(), uid, req.Name)
	if err != nil {
		mapErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": g})
}

func (h Handler) List(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gs, err := h.svc.ListGroups(c.Request.Context(), uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gs)
}

func (h Handler) Join(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	var req codeBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	g, err := h.svc.JoinByCode(c.Request.Context(), uid, req.Code)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, g)
}

func (h Handler) Detail(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	d, err := h.svc.Detail(c.Request.Context(), uid, gid)
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, d)
}

func (h Handler) Code(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	isM, err := h.repo.IsMember(c.Request.Context(), gid, uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	if !isM {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
		return
	}
	g, err := h.repo.FindByID(c.Request.Context(), gid)
	if err != nil || g == nil {
		httpx.Error(c, http.StatusNotFound, "not_found", "group not found")
		return
	}
	httpx.OK(c, gin.H{"code": g.InviteCode, "link": "mobile://group/" + g.InviteCode})
}

func (h Handler) Progress(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	isM, err := h.repo.IsMember(c.Request.Context(), gid, uid)
	if err != nil {
		mapErr(c, err)
		return
	}
	if !isM {
		httpx.Error(c, http.StatusForbidden, "forbidden", "not allowed")
		return
	}
	rows, err := h.repo.ListMembersForProgress(c.Request.Context(), gid)
	if err != nil {
		mapErr(c, err)
		return
	}
	members := make([]compare.Member, 0, len(rows))
	for _, r := range rows {
		members = append(members, compare.Member{ID: r.ID, DisplayName: r.DisplayName, ShareProgress: r.ShareProgress, TargetKcal: r.TargetKcal})
	}
	out, err := h.compare.ProgressForMembers(c.Request.Context(), time.Now(), user.LocFromContext(c), members)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load progress")
		return
	}
	httpx.OK(c, gin.H{"members": out})
}

func (h Handler) Invite(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req inviteBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	friendID, err := uuid.Parse(req.UserID)
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid user_id")
		return
	}
	if err := h.svc.InviteFriend(c.Request.Context(), uid, gid, friendID); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"invited": true})
}

func (h Handler) RemoveMember(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	memberID, ok := h.parseID(c, "userId")
	if !ok {
		return
	}
	// self -> leave; other -> owner-remove
	var err error
	if memberID == uid {
		err = h.svc.Leave(c.Request.Context(), uid, gid)
	} else {
		err = h.svc.RemoveMember(c.Request.Context(), uid, gid, memberID)
	}
	if err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"removed": true})
}

func (h Handler) Rename(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	var req nameBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	if err := h.svc.Rename(c.Request.Context(), uid, gid, req.Name); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"renamed": true})
}

func (h Handler) Delete(c *gin.Context) {
	uid, ok := h.uid(c)
	if !ok {
		return
	}
	gid, ok := h.parseID(c, "id")
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), uid, gid); err != nil {
		mapErr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}
