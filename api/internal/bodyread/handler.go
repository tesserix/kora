package bodyread

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// maxImageBytes caps an uploaded body-composition screenshot. Same figure as
// resolve.maxPhotoBytes — a smart-scale screenshot is a photo upload with
// the same realistic size range as a meal photo, and vision providers reject
// huge inputs regardless. Defined locally rather than imported: resolve's
// constant is unexported.
const maxImageBytes = 8 << 20 // 8 MiB

// maxImageBodyBytes is the hard cap applied to the raw request body ahead of
// multipart parsing. The headroom above maxImageBytes covers the multipart
// boundary markers and part headers surrounding the file bytes — same
// reasoning as resolve.maxPhotoBodyBytes.
const maxImageBodyBytes = maxImageBytes + 1<<10

// Handler exposes Reader over HTTP. reader is nil when no ai.Provider is
// configured (server.NewRouter's wiring) — Read then answers 503 rather
// than panicking, so manual entry still works with the AI reader disabled,
// exactly like recipes.Handler.Parse's nil *recipes.Parser.
type Handler struct {
	reader *Reader
}

// NewHandler builds a Handler over reader, which may be nil (see Handler's
// doc comment).
func NewHandler(reader *Reader) Handler {
	return Handler{reader: reader}
}

// Read accepts a multipart "file" upload of a smart-scale result screenshot
// and returns the body-composition reading extracted from it.
func (h Handler) Read(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	if h.reader == nil {
		httpx.Error(c, http.StatusServiceUnavailable, "unavailable", "body composition reading is unavailable")
		return
	}

	// Bound the raw body BEFORE multipart parsing so an oversized upload is
	// rejected while streaming in, not after Gin has fully buffered it —
	// same ordering as resolve.Handler.ResolvePhoto.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxImageBodyBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "image exceeds 8MB limit")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "file is required")
		return
	}
	if fileHeader.Size > maxImageBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "image exceeds 8MB limit")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	defer f.Close()
	buf, err := io.ReadAll(f) // bounded by MaxBytesReader above
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	mime := fileHeader.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(buf)
	}

	result, err := h.reader.Read(c.Request.Context(), uid, buf, mime)
	if err != nil {
		// Out of AI budget is not a read failure: the screenshot was never
		// looked at, and retrying will not help until the exhausted window
		// resets. 429 mirrors recipes.Handler.Parse's exact treatment of
		// recipes.ErrBudgetExhausted.
		if errors.Is(err, ErrBudgetExhausted) {
			httpx.Error(c, http.StatusTooManyRequests, "budget_exhausted",
				"You've reached your AI usage limit — try again later")
			return
		}
		// Any other error is a real provider/infra failure (timeout, 5xx,
		// malformed response) — distinct from Result.Unreadable below, which
		// only fires once the provider HAS answered but nothing in the
		// answer survives validation. RespondServiceError reports this as a
		// generic 5xx, matching every other handler in this repo.
		httpx.RespondServiceError(c, err)
		return
	}

	if result.Unreadable {
		httpx.Error(c, http.StatusUnprocessableEntity, "unreadable", "couldn't read anything from that screenshot")
		return
	}

	httpx.OK(c, result)
}
