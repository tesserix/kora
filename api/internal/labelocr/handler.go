package labelocr

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/user"
)

// ReadLimit bounds label reads per user per ReadPeriod, ahead of the AI budget.
const (
	ReadLimit  = 20
	ReadPeriod = time.Minute
)

const (
	maxPhotoBytes     = 8 << 20
	maxPhotoBodyBytes = maxPhotoBytes + 1<<10
)

var acceptedTypes = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true}

type Reader interface {
	Read(ctx context.Context, photo []byte, mime string) (Read, error)
}

// Budget is the caller's AI quota; billing.Meter satisfies it.
type Budget interface {
	WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error)
	Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error
}

type Handler struct {
	reader Reader
	budget Budget
}

func NewHandler(reader Reader, budget Budget) Handler { return Handler{reader: reader, budget: budget} }

// Read serves POST /v1/resolve/label: a photo of a nutrition panel in, a checked Label out.
func (h Handler) Read(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPhotoBodyBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
			return
		}
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "file is required")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	defer f.Close()
	photo, err := io.ReadAll(io.LimitReader(f, maxPhotoBytes+1))
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	if len(photo) > maxPhotoBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
		return
	}
	mime := http.DetectContentType(photo)
	if !acceptedTypes[mime] {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "photo must be JPEG, PNG or WebP")
		return
	}

	within, err := h.budget.WithinBudget(c.Request.Context(), uid)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	if !within {
		httpx.Error(c, http.StatusTooManyRequests, "budget_exhausted", "You've reached your AI usage limit — try again later")
		return
	}

	started := time.Now()
	read, err := h.reader.Read(c.Request.Context(), photo, mime)
	h.record(c.Request.Context(), uid, read.CostUSD, time.Since(started), err)
	if err == nil {
		var label Label
		if label, err = Check(read.Fields, read.Failures); err == nil {
			httpx.OK(c, label)
			return
		}
	}
	if errors.Is(err, ErrUnreadable) {
		httpx.Error(c, http.StatusUnprocessableEntity, "label_unreadable", "no nutrition panel could be read; retake the photo closer and flat")
		return
	}
	httpx.RespondServiceError(c, err)
}

// record charges every attempt, failed or not, so label reads spend the same quota as photo reads.
func (h Handler) record(ctx context.Context, uid uuid.UUID, costUSD float64, took time.Duration, err error) {
	u := ai.Usage{Provider: "document-intelligence", CallType: "read_label", LatencyMs: int(took.Milliseconds()), Outcome: ai.OutcomeOK}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		u.Outcome = ai.OutcomeTimeout
	case err != nil:
		u.Outcome = ai.OutcomeError
	}
	_ = h.budget.Record(context.WithoutCancel(ctx), uid, u, costUSD) // metering must never fail the read
}
