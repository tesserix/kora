package admin

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/bffauth"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// foodPayload is the wire shape of POST /v1/admin/foods and
// PATCH /v1/admin/foods/:id. Both are FULL representations — UpdateFood
// applies a whole-row map update, so a PATCH that omitted a field would not
// leave it alone, it would need a value from somewhere. Requiring every
// field on both verbs is the honest encoding of that.
//
// Every required field is a POINTER so "absent" and "zero" stay
// distinguishable. With plain float64s, a body omitting protein_per_100g
// would store 0 and be indistinguishable from an operator who genuinely
// meant zero protein — silently, on a nutrition database. Absent is a 400.
//
// There is deliberately NO actor field of any kind. The actor is read from
// the bffauth-verified context in actorFrom below and can never be
// influenced by the body: this struct is the enforcement, not a convention.
// Unknown JSON keys (including an injected "actor_id") land nowhere.
type foodPayload struct {
	Name         *string  `json:"name"`
	Brand        string   `json:"brand"`
	Provenance   string   `json:"provenance"`
	Barcode      *string  `json:"barcode"`
	ServingDesc  string   `json:"serving_desc"`
	ServingGrams *float64 `json:"serving_grams"`

	KcalPer100g    *float64 `json:"kcal_per_100g"`
	ProteinPer100g *float64 `json:"protein_per_100g"`
	CarbsPer100g   *float64 `json:"carbs_per_100g"`
	FatPer100g     *float64 `json:"fat_per_100g"`
	FiberPer100g   *float64 `json:"fiber_per_100g"`

	// UpdatedAt is the optimistic-concurrency precondition (task-5 brief,
	// rider 1): the value the caller last read for this row. Required on
	// PATCH, ignored on POST (a row that does not exist yet cannot be
	// clobbered). If this were optional, every client that forgot it would
	// silently opt out of the protection it exists to provide.
	UpdatedAt *time.Time `json:"updated_at"`
}

// Macro sanity bounds. Non-negative alone does not catch the realistic
// operator error, which is pasting PER-SERVING values into per-100g fields:
// 1200 kcal and 150g protein are both non-negative and both nonsense. A
// gram-per-100g field cannot exceed 100 by definition; kcal per 100g cannot
// exceed ~900 (pure fat). Both bounds are inclusive so the legitimate
// extremes — pure oil, pure whey isolate — still pass.
const (
	maxGramsPer100g = 100.0
	maxKcalPer100g  = 900.0
)

// allowedProvenance is the closed set an admin may set. Anything outside it
// is a 400 rather than a stored typo: provenance is queried and filtered on,
// so a misspelling creates a row that silently drops out of every report
// that groups by it.
var allowedProvenance = map[string]bool{
	nutrition.ProvenanceAFCD:         true,
	nutrition.ProvenanceOFF:          true,
	nutrition.ProvenanceUSDA:         true,
	nutrition.ProvenanceLabelOCR:     true,
	nutrition.ProvenanceUserEstimate: true,
	nutrition.ProvenanceCurated:      true,
}

// toInput validates the payload and converts it to a FoodInput. It returns a
// client-safe message on rejection; the caller renders it as a 400 and MUST
// NOT reach the repository.
func (p foodPayload) toInput() (FoodInput, string) {
	if p.Name == nil || strings.TrimSpace(*p.Name) == "" {
		return FoodInput{}, "name is required"
	}
	if p.ServingGrams == nil || *p.ServingGrams <= 0 {
		return FoodInput{}, "serving_grams must be a positive number"
	}

	provenance := strings.TrimSpace(p.Provenance)
	if provenance == "" {
		// An admin food is hand-authored. Defaulting to "" would make the
		// row indistinguishable from an importer bug.
		provenance = nutrition.ProvenanceCurated
	}
	if !allowedProvenance[provenance] {
		return FoodInput{}, "provenance is not a recognised value"
	}

	macros := []struct {
		name  string
		value *float64
		max   float64
	}{
		{"kcal_per_100g", p.KcalPer100g, maxKcalPer100g},
		{"protein_per_100g", p.ProteinPer100g, maxGramsPer100g},
		{"carbs_per_100g", p.CarbsPer100g, maxGramsPer100g},
		{"fat_per_100g", p.FatPer100g, maxGramsPer100g},
		{"fiber_per_100g", p.FiberPer100g, maxGramsPer100g},
	}
	for _, m := range macros {
		if m.value == nil {
			return FoodInput{}, m.name + " is required"
		}
		if *m.value < 0 {
			return FoodInput{}, m.name + " must not be negative"
		}
		if *m.value > m.max {
			return FoodInput{}, m.name + " is out of range for a per-100g value"
		}
	}

	barcode := p.Barcode
	if barcode != nil {
		// An all-whitespace barcode is not a barcode. Storing one would
		// claim the unique index for a value no scanner can ever produce.
		if trimmed := strings.TrimSpace(*barcode); trimmed == "" {
			barcode = nil
		} else {
			barcode = &trimmed
		}
	}

	return FoodInput{
		Name:           strings.TrimSpace(*p.Name),
		Brand:          strings.TrimSpace(p.Brand),
		Provenance:     provenance,
		Barcode:        barcode,
		ServingDesc:    strings.TrimSpace(p.ServingDesc),
		ServingGrams:   *p.ServingGrams,
		KcalPer100g:    *p.KcalPer100g,
		ProteinPer100g: *p.ProteinPer100g,
		CarbsPer100g:   *p.CarbsPer100g,
		FatPer100g:     *p.FatPer100g,
		FiberPer100g:   *p.FiberPer100g,
	}, ""
}

// bindPayload decodes and validates the body. It returns ok=false having
// ALREADY written the 400, so callers can `return` immediately and no path
// can reach the repository with an unvalidated payload.
func bindPayload(c *gin.Context) (foodPayload, FoodInput, bool) {
	var p foodPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "request body is not valid JSON for a food")
		return foodPayload{}, FoodInput{}, false
	}
	in, msg := p.toInput()
	if msg != "" {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", msg)
		return foodPayload{}, FoodInput{}, false
	}
	return p, in, true
}

// actorFrom builds the audit Actor from the bffauth-verified context — the
// ONLY source. recordEvent trusts Actor completely and writes it straight
// into kora_admin_events, so a body-derived actor would make the audit trail
// forgeable by exactly the person it exists to attribute.
//
// A missing identity is a 401, never an empty Actor: in production
// bffauth.Middleware makes that unreachable, and if this route were ever
// mounted outside that group the right failure is a refusal, not an audit
// row attributed to nobody.
func actorFrom(c *gin.Context) (Actor, bool) {
	id := c.GetString(bffauth.CtxAdminID)
	email := c.GetString(bffauth.CtxAdminEmail)
	if id == "" || email == "" {
		httpx.Error(c, http.StatusUnauthorized, "unauthorized", "admin identity missing")
		return Actor{}, false
	}
	return Actor{ID: id, Email: email}, true
}

// pathID parses :id. A malformed id is a 400 here rather than being passed
// to the repository as a zero UUID, which would 404 and read as "that food
// does not exist" when the truth is "that is not an id".
func pathID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(strings.TrimSpace(c.Param("id")))
	if err != nil {
		httpx.Error(c, http.StatusBadRequest, "invalid_input", "id must be a UUID")
		return uuid.Nil, false
	}
	return id, true
}

// respondMutation renders the outcome of an UpdateFood/SoftDeleteFood call,
// which is where the four riders' error taxonomy actually pays off:
//
//   - ErrCacheGenerationBump — the transaction COMMITTED and only the
//     post-commit cache bump failed. Rendering that as a failure would make
//     an operator redo an edit that already succeeded (rider 4). It is a 200
//     carrying the committed row, with the stale-cache fact in meta and the
//     real cause attached to the request log via c.Error.
//   - ErrStaleUpdate — someone else wrote this row between the caller's read
//     and this write (rider 1). 409, so the portal can say "reload", not 404
//     ("it's gone") and not 500.
//   - ErrDuplicateBarcode — 409 naming the collision (rider 2). This is the
//     one place a repository error message is passed to the client verbatim:
//     the caller is a platform admin and the colliding row's name is the
//     entire value of the message.
//   - gorm.ErrRecordNotFound — 404.
//   - anything else — RespondServiceError's generic 500, detail logged only.
func respondMutation(c *gin.Context, snap FoodSnapshot, err error) {
	switch {
	case err == nil:
		httpx.OKWithMeta(c, snap, gin.H{"cache_bump_failed": false})
	case errors.Is(err, ErrCacheGenerationBump):
		// Logged, not returned: the client gets the success this was.
		_ = c.Error(err)
		httpx.OKWithMeta(c, snap, gin.H{"cache_bump_failed": true})
	case errors.Is(err, ErrStaleUpdate):
		httpx.Error(c, http.StatusConflict, "stale_update",
			"this food was changed by someone else since you loaded it — reload and reapply your edit")
	case errors.Is(err, ErrDuplicateBarcode):
		httpx.Error(c, http.StatusConflict, "duplicate_barcode", err.Error())
	case errors.Is(err, gorm.ErrRecordNotFound):
		httpx.Error(c, http.StatusNotFound, "not_found", "food not found")
	default:
		httpx.RespondServiceError(c, err)
	}
}

// CreateFood serves POST /v1/admin/foods.
func (h Handler) CreateFood(c *gin.Context) {
	actor, ok := actorFrom(c)
	if !ok {
		return
	}
	_, in, ok := bindPayload(c)
	if !ok {
		return
	}

	created, err := h.mutations.CreateFood(c.Request.Context(), actor, in)
	if err != nil {
		// CreateFood has no post-commit cache bump (a brand-new food cannot
		// be in the resolve cache), so it never returns
		// ErrCacheGenerationBump — but it shares the rest of the taxonomy,
		// notably ErrDuplicateBarcode.
		respondMutation(c, created, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": created})
}

// UpdateFood serves PATCH /v1/admin/foods/:id.
func (h Handler) UpdateFood(c *gin.Context) {
	actor, ok := actorFrom(c)
	if !ok {
		return
	}
	id, ok := pathID(c)
	if !ok {
		return
	}
	p, in, ok := bindPayload(c)
	if !ok {
		return
	}
	if p.UpdatedAt == nil || p.UpdatedAt.IsZero() {
		httpx.Error(c, http.StatusBadRequest, "invalid_input",
			"updated_at is required — echo the value you loaded so a concurrent edit cannot be silently overwritten")
		return
	}

	updated, err := h.mutations.UpdateFood(c.Request.Context(), actor, id, in, *p.UpdatedAt)
	respondMutation(c, updated, err)
}

// SoftDeleteFood serves DELETE /v1/admin/foods/:id. It reads no body: a
// delete has no payload, and accepting one would be a second, unnecessary
// place an actor could be smuggled in from.
func (h Handler) SoftDeleteFood(c *gin.Context) {
	actor, ok := actorFrom(c)
	if !ok {
		return
	}
	id, ok := pathID(c)
	if !ok {
		return
	}

	deleted, err := h.mutations.SoftDeleteFood(c.Request.Context(), actor, id)
	respondMutation(c, deleted, err)
}
