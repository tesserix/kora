package user

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// AppleExchanger is the slice of appleid.Client this handler needs. Declared
// here so the handler's tests can drive a fake without an Apple client.
type AppleExchanger interface {
	ExchangeAuthorizationCode(ctx context.Context, code string) (string, error)
}

type AppleHandler struct {
	repo      Repository
	exchanger AppleExchanger
}

func NewAppleHandler(repo Repository, exchanger AppleExchanger) AppleHandler {
	return AppleHandler{repo: repo, exchanger: exchanger}
}

type appleAuthorizationBody struct {
	AuthorizationCode string `json:"authorization_code"`
}

// Store exchanges Apple's one-time authorization code for a refresh token and
// saves it against the caller's own row. The row is resolved from the auth
// context — there is no user id in the request to forge.
//
// The code is returned by Apple ONLY at sign-in, so this is the single
// opportunity to capture it for a given authorization.
func (h AppleHandler) Store(c *gin.Context) {
	id, ok := IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	var req appleAuthorizationBody
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed body")
		return
	}
	code := strings.TrimSpace(req.AuthorizationCode)
	if code == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "authorization code is required")
		return
	}
	token, err := h.exchanger.ExchangeAuthorizationCode(c.Request.Context(), code)
	if err != nil {
		// Apple's diagnostic is useful in logs and useless (or misleading) to
		// a client, so it stays server-side.
		httpx.Error(c, http.StatusBadGateway, "upstream_error", "could not verify with Apple")
		return
	}
	if err := h.repo.SetAppleRefreshToken(c.Request.Context(), id, token); err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not store authorization")
		return
	}
	c.Status(http.StatusNoContent)
}
