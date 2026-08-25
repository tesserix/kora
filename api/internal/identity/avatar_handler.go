package identity

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/imageproc"
)

// maxAvatarBodyBytes bounds the whole request body, which is larger than the
// image it carries: multipart adds a boundary, headers and a filename per part.
// Same headroom reasoning as internal/bodyread/handler.go, so a picture at
// exactly the image cap is not refused for its envelope.
const maxAvatarBodyBytes = imageproc.MaxAvatarBytes + (1 << 20)

// SetAvatar accepts a multipart "file" part.
//
// The upload goes through the API rather than direct-to-GCS with a signed URL,
// deliberately: the API MUST do the normalisation -- the pixel cap, the crop,
// the JPEG re-encode that removes GPS coordinates -- and a client cannot be
// trusted to have done it. A signed upload URL would let any client put any
// bytes in the bucket under its own name.
func (h Handler) SetAvatar(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}

	// Bound the raw body BEFORE multipart parsing, so an oversized upload is
	// refused without being buffered.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAvatarBodyBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "image_too_large",
				"That picture is too large. Pick one under 8 MB.")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "a 'file' part is required")
		return
	}

	f, err := fileHeader.Open()
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "couldn't read that file")
		return
	}
	defer f.Close()

	data, err := io.ReadAll(f) // bounded by MaxBytesReader above
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "couldn't read that file")
		return
	}

	url, err := h.svc.SetAvatar(c.Request.Context(), uid, data)
	if err != nil {
		switch {
		case errors.Is(err, imageproc.ErrImageTooLarge):
			httpx.Error(c, http.StatusRequestEntityTooLarge, "image_too_large",
				"That picture is too large. Pick one under 8 MB.")
		case errors.Is(err, imageproc.ErrUnreadableImage):
			httpx.Error(c, http.StatusBadRequest, "invalid_image",
				"That file isn't a picture Kora can read. Try a JPEG or PNG.")
		default:
			writeErr(c, err)
		}
		return
	}
	httpx.OK(c, gin.H{"avatar_url": url})
}

func (h Handler) ClearAvatar(c *gin.Context) {
	uid, ok := h.resolveUser(c)
	if !ok {
		return
	}
	if err := h.svc.ClearAvatar(c.Request.Context(), uid); err != nil {
		writeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
