// Package resolve exposes the AI food-resolution engine over HTTP. It is a
// thin transport layer: all resolution logic lives in package ai and the
// nutrition index; this package only parses requests, enforces limits, calls
// the injected resolver, and formats responses. It never introduces a
// nutrition number — every kcal/macro in a response originates from a
// nutrition.FoodItem row inside the engine.
package resolve

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/user"
)

// maxPhotoBytes caps an uploaded resolve photo. Vision models reject huge
// inputs anyway; this protects the server from oversized uploads.
const maxPhotoBytes = 8 << 20 // 8 MiB

// barcodeUnknownQuestion is returned (with no candidates, no fabricated row)
// when a scanned barcode matches nothing locally or on OpenFoodFacts.
const barcodeUnknownQuestion = "Barcode not recognized — search and log manually."

// barcodeDefaultGrams is the portion assumed for a barcode hit, which carries
// no portion signal. Nutrition is still row-sourced: kcal = KcalPer100g * 1.
const barcodeDefaultGrams = 100.0

type TextPhotoResolver interface {
	ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (ai.Resolution, error)
	ResolvePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (ai.Resolution, error)
}

type BarcodeResolver func(ctx context.Context, code string) (*nutrition.FoodItem, bool, error)

type Handler struct {
	tp TextPhotoResolver
	bc BarcodeResolver
}

func NewHandler(tp TextPhotoResolver, bc BarcodeResolver) Handler {
	return Handler{tp: tp, bc: bc}
}

type textRequest struct {
	Phrase string `json:"phrase"`
}

func (h Handler) ResolveText(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req textRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Phrase) < 2 {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "phrase must be at least 2 characters")
		return
	}
	res, err := h.tp.ResolveText(c.Request.Context(), uid, req.Phrase)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res)
}

func (h Handler) ResolvePhoto(c *gin.Context) {
	uid, ok := user.IDFromContext(c)
	if !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "file is required")
		return
	}
	if fileHeader.Size > maxPhotoBytes {
		httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	defer f.Close()
	buf := make([]byte, 0, fileHeader.Size)
	tmp := make([]byte, 32<<10)
	for {
		n, rerr := f.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if rerr != nil {
			break
		}
		if len(buf) > maxPhotoBytes {
			httpx.Error(c, http.StatusRequestEntityTooLarge, "payload_too_large", "photo exceeds 8MB limit")
			return
		}
	}
	mime := fileHeader.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(buf)
	}
	res, err := h.tp.ResolvePhoto(c.Request.Context(), uid, buf, mime)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	httpx.OK(c, res)
}

type barcodeRequest struct {
	Barcode string `json:"barcode"`
}

func (h Handler) ResolveBarcode(c *gin.Context) {
	if _, ok := user.IDFromContext(c); !ok {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "missing user")
		return
	}
	var req barcodeRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Barcode == "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "barcode is required")
		return
	}
	item, found, err := h.bc(c.Request.Context(), req.Barcode)
	if err != nil {
		httpx.RespondServiceError(c, err)
		return
	}
	if !found {
		httpx.OK(c, ai.Resolution{
			Tier:             ai.TierFollowUp,
			FollowUpQuestion: barcodeUnknownQuestion,
			Provenance:       "barcode",
		})
		return
	}
	// Nutrition is row-sourced: kcal = KcalPer100g * (grams/100).
	kcal := item.KcalPer100g * barcodeDefaultGrams / 100
	httpx.OK(c, ai.Resolution{
		Candidates: []ai.ResolvedCandidate{{
			Item:         *item,
			PortionGrams: barcodeDefaultGrams,
			Kcal:         kcal,
			MatchScore:   1.0,
			MatchTier:    nutrition.MatchAlias, // exact barcode == exact match
		}},
		Tier:       ai.TierAuto,
		Provenance: item.Provenance,
	})
}
