package tracking

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/access"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// FriendBodyHandler serves GET /v1/friends/:userId/body — another person's
// weigh-ins, when they have granted access.CategoryBody (kora#438).
//
// Separate from Handler, which is entirely own-user: everything here has to
// answer "may this viewer see it" first, and mixing the two would put a
// handler with no grant check one line away from one that needs it.
type FriendBodyHandler struct {
	repo      Repository
	accessSvc access.Service
}

func NewFriendBodyHandler(repo Repository, accessSvc access.Service) FriendBodyHandler {
	return FriendBodyHandler{repo: repo, accessSvc: accessSvc}
}

// notFound is every rejection this handler has.
//
// Not-shared, not-a-friend, no-such-user and a malformed id are ONE response:
// same status, same body. A 403 on the not-shared case would confirm that the
// data exists and is being withheld, which leaks the existence of something
// the owner chose not to share. The message says nothing about why, for the
// same reason.
func notFound(c *gin.Context) {
	httpx.Error(c, http.StatusNotFound, "not_found", "Not found.")
}

func (h FriendBodyHandler) Get(c *gin.Context) {
	viewer, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return
	}
	ownerID, err := uuid.Parse(c.Param("userId"))
	if err != nil {
		notFound(c)
		return
	}

	// The parsed id is used ONLY to resolve. What reaches the query is the
	// Grant, whose owner cannot be set from out here.
	grant, err := h.accessSvc.Resolve(c.Request.Context(), viewer, ownerID, access.CategoryBody)
	if err != nil {
		// access.Resolve had zero production callers before this handler, so
		// ErrNotShared has no mapping in httpx.RespondServiceError and would
		// otherwise surface as a 500. Mapped here rather than in httpx
		// because httpx is the response envelope and is deliberately free of
		// domain errors; share/handler.go's respond() maps ErrNotOwner the
		// same way, for the same reason. What stops the NEXT cross-user
		// handler forgetting is the per-path assertion in
		// access/enforcement_test.go, not this function.
		if errors.Is(err, access.ErrNotShared) {
			notFound(c)
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}

	from, to := weightWindow(c)
	entries, err := h.repo.BodySeriesFor(c.Request.Context(), grant, from, to)
	if err != nil {
		httpx.Error(c, http.StatusInternalServerError, "internal_error", "could not load body series")
		return
	}
	httpx.OK(c, entries)
}
