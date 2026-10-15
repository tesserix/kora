package signin

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// MountAccount registers the signed-in person's two-step settings on g, which
// must already sit behind auth.Middleware: each route acts on the Zitadel
// user the caller's token names, and on no other.
func (h *Handler) MountAccount(g *gin.RouterGroup) {
	g.GET("/me/two-step", h.twoStepStatus)
	g.POST("/me/two-step/setup", h.twoStepSetup)
	g.POST("/me/two-step/confirm", h.twoStepConfirm)
	g.POST("/me/two-step/disable", h.twoStepDisable)
}

// caller is the Zitadel user id auth.Middleware put on the request.
func (h *Handler) caller(c *gin.Context) (string, bool) {
	if !h.ready(c) {
		return "", false
	}
	uid := c.GetString("uid")
	if uid == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return "", false
	}
	return uid, true
}

func (h *Handler) hasTOTP(c *gin.Context, uid string) (bool, bool) {
	methods, err := h.zitadel.authMethods(c.Request.Context(), uid)
	if err != nil {
		unavailable(c, "read auth methods", err)
		return false, false
	}
	return slices.Contains(methods, "AUTHENTICATION_METHOD_TYPE_TOTP"), true
}

func (h *Handler) twoStepStatus(c *gin.Context) {
	uid, ok := h.caller(c)
	if !ok {
		return
	}
	enabled, ok := h.hasTOTP(c, uid)
	if !ok {
		return
	}
	httpx.OK(c, gin.H{"enabled": enabled})
}

// twoStepSetup starts adding an authenticator app. Calling it again before
// confirming replaces the unconfirmed secret, so a person who gives up halfway
// can simply start over.
func (h *Handler) twoStepSetup(c *gin.Context) {
	uid, ok := h.caller(c)
	if !ok {
		return
	}
	enabled, ok := h.hasTOTP(c, uid)
	if !ok {
		return
	}
	if enabled {
		httpx.Error(c, http.StatusConflict, "already_enabled", "Two-step verification is already on.")
		return
	}
	setup, err := h.zitadel.registerTOTP(c.Request.Context(), uid)
	if err != nil {
		unavailable(c, "register totp", err)
		return
	}
	httpx.OK(c, gin.H{"uri": setup.URI, "secret": setup.Secret})
}

type twoStepCodeRequest struct {
	Code string `json:"code"`
}

// twoStepCode reads a 6-digit code from the body, rate limited per person so
// a stolen session cannot walk the code space.
func (h *Handler) twoStepCode(c *gin.Context, uid string) (string, bool) {
	var req twoStepCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid request body")
		return "", false
	}
	code := strings.Join(strings.Fields(req.Code), "")
	if len(code) != 6 || strings.Trim(code, "0123456789") != "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "Enter the 6-digit code from your authenticator app.")
		return "", false
	}
	if limited(c, h.codes, "two-step:"+uid) {
		return "", false
	}
	return code, true
}

func (h *Handler) twoStepConfirm(c *gin.Context) {
	uid, ok := h.caller(c)
	if !ok {
		return
	}
	code, ok := h.twoStepCode(c, uid)
	if !ok {
		return
	}
	err := h.zitadel.verifyTOTPRegistration(c.Request.Context(), uid, code)
	switch {
	case errors.Is(err, errInvalidCode):
		httpx.Error(c, http.StatusBadRequest, "invalid_code", "That code didn't work. Check the time on your phone and try the newest code.")
	case err != nil:
		unavailable(c, "verify totp registration", err)
	default:
		httpx.OK(c, gin.H{"enabled": true})
	}
}

// twoStepDisable turns two-step off, but only for a current code: an unlocked
// phone in someone else's hands must not be enough to remove it.
func (h *Handler) twoStepDisable(c *gin.Context) {
	uid, ok := h.caller(c)
	if !ok {
		return
	}
	code, ok := h.twoStepCode(c, uid)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	err := h.zitadel.totpSession(ctx, uid, code)
	switch {
	case errors.Is(err, errInvalidCode):
		httpx.Error(c, http.StatusBadRequest, "invalid_code", "That code didn't work. Check your authenticator app and try again.")
		return
	case err != nil:
		unavailable(c, "check totp before removal", err)
		return
	}
	if err := h.zitadel.removeTOTP(ctx, uid); err != nil {
		unavailable(c, "remove totp", err)
		return
	}
	httpx.OK(c, gin.H{"enabled": false})
}
