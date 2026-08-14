package recipes

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// maxPhotoBytes caps an uploaded recipe photo, matching resolve's limit.
const maxPhotoBytes = 8 << 20
const maxPhotoBodyBytes = maxPhotoBytes + 1<<10

type Handler struct {
	svc    *Service
	parser *Parser
}

func NewHandler(svc *Service, parser *Parser) Handler { return Handler{svc: svc, parser: parser} }

func (h Handler) resolveUser(c *gin.Context) (uuid.UUID, bool) {
	id, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "invalid or missing token")
		return uuid.Nil, false
	}
	return id, true
}

// recipeID parses the path id. An unparseable id is a 400; a well-formed id
// the caller does not own becomes a 404 further down, never a 403, so ids
// stay non-enumerable.
func (h Handler) recipeID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "invalid recipe id")
		return uuid.Nil, false
	}
	return id, true
}

func (h Handler) notFoundOr(c *gin.Context, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpx.Error(c, http.StatusNotFound, "not_found", "recipe not found")
		return
	}
	httpx.RespondServiceError(c, err)
}

func (h Handler) List(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	out, err := h.svc.List(c.Request.Context(), userID)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h Handler) Get(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	v, err := h.svc.Get(c.Request.Context(), userID, id)
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, v)
}

func (h Handler) Create(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	var req SaveRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed recipe body")
		return
	}
	v, err := h.svc.Create(c.Request.Context(), userID, req)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": v})
}

func (h Handler) Update(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	var req SaveRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed recipe body")
		return
	}
	v, err := h.svc.Update(c.Request.Context(), userID, id, req)
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, v)
}

func (h Handler) Delete(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), userID, id); err != nil {
		h.notFoundOr(c, err)
		return
	}
	httpx.OK(c, gin.H{"deleted": true})
}

// Parse accepts pasted text (JSON) or a photo (multipart) and returns an
// UNSAVED draft. It writes nothing, so an abandoned parse leaves no rows.
func (h Handler) Parse(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if h.parser == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "unavailable", "recipe reading is unavailable")
		return
	}

	var (
		draft Draft
		err   error
	)
	if ct := c.ContentType(); ct == "multipart/form-data" {
		// Bound the body BEFORE multipart parsing buffers it, so an oversized
		// upload is rejected while streaming in rather than after being fully
		// read into memory — same ordering as resolve.Handler.ResolvePhoto.
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPhotoBodyBytes)
		file, header, ferr := c.Request.FormFile("photo")
		if ferr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "a photo is required")
			return
		}
		defer file.Close()
		image, rerr := io.ReadAll(file)
		if rerr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "could not read the photo")
			return
		}
		draft, err = h.parser.ParsePhoto(c.Request.Context(), userID, image, header.Header.Get("Content-Type"))
	} else {
		var body struct {
			Text string `json:"text"`
		}
		if berr := c.ShouldBindJSON(&body); berr != nil {
			httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed parse body")
			return
		}
		draft, err = h.parser.ParseText(c.Request.Context(), userID, body.Text)
	}

	if err != nil {
		// Out of AI budget is not a parse failure: the recipe was never read,
		// and retrying will not help until the month rolls over. 429 with a
		// message that points at the manual editor, which needs no provider.
		if errors.Is(err, ErrBudgetExhausted) {
			httpx.Error(c, http.StatusTooManyRequests, "budget_exhausted",
				"You've reached your AI limit this month — enter the recipe manually")
			return
		}
		// A parse failure is 502, not 500: the upstream model could not read
		// it. The client renders this as "enter it manually" and opens the
		// manual editor — a dead end here must not be a dead end for the task.
		if errors.Is(err, ErrParseFailed) {
			httpx.Error(c, http.StatusBadGateway, "parse_failed",
				"Couldn't read that recipe — enter it manually")
			return
		}
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, draft)
}

func (h Handler) Log(c *gin.Context) {
	userID, ok := h.resolveUser(c)
	if !ok {
		return
	}
	id, ok := h.recipeID(c)
	if !ok {
		return
	}
	var req LogRecipeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "malformed log body")
		return
	}
	res, err := h.svc.LogRecipe(c.Request.Context(), userID, id, req, user.LocFromContext(c))
	if err != nil {
		h.notFoundOr(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": res})
}
